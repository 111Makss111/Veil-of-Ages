import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { requirePool } from './db.js';
import { ownerOrigin } from './owner-auth.js';
import { mediaKind, renderMedia, runMediaTool, checkMediaTools, MAX_OUTPUT_BYTES, MediaToolError } from './media-render.js';
import { createObjectStore, STORAGE_LIMIT, INPUT_LIMIT, type ObjectStore } from './factory-storage.js';
import { FactoryError, reserveAsset, startRelease, factoryLock } from './factory-store.js';
import { factoryPage, factoryCss, factoryScript } from './factory-ui.js';
import { createCloudflareImageGenerator, type ImageGenerator } from './factory-ai.js';
import { ACTIVE_EFFECT_IDS, EFFECT_CATALOG, motionIntensitySchema } from './factory-effects.js';

const uuid=z.string().uuid();
const vocal=z.enum(['instrumental','choir']);
const UPLOAD_MAX=25*1024*1024;
export async function factoryRoutes(app: FastifyInstance, options: { storage?: ObjectStore; render?: typeof renderMedia; probe?: (file: string, kind: string) => Promise<number>; imageGenerator?: ImageGenerator|null } = {}) {
  const storage=options.storage ?? createObjectStore();
  const imageGenerator=options.imageGenerator===undefined?createCloudflareImageGenerator():options.imageGenerator;
  const tasks=new Set<Promise<void>>(); const controller=new AbortController(); let uploading=false;
  const needStorage=()=>{if(!storage)throw new FactoryError(503,'Підключи приватне сховище R2 в Render. Файли ще не завантажуються.');return storage;};
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin')
      .header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(!req.ownerSession?.verified)return reply.code(401).send({error:'Увійди в кабінет і підтвердь Authenticator.'});
    if(req.method==='POST'&&req.headers.origin!==ownerOrigin())return reply.code(403).send({error:'Відкрий фабрику зі свого кабінету.'});
  });
  app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof FactoryError?e.status:e instanceof z.ZodError?400:503).send({error:e instanceof FactoryError?e.message:e instanceof z.ZodError?'Перевір заповнені поля.':'Операцію не підтверджено. Онови стан перед повтором. Перевір підключення R2 та бази.'}));
  await app.register(multipart,{limits:{files:1,fields:0,parts:1,fileSize:UPLOAD_MAX}});
  app.addHook('onClose',async()=>{controller.abort();await Promise.allSettled([...tasks]);});
  app.get('/factory',async(_req,reply)=>reply.type('text/html').send(factoryPage));
  app.get('/factory/style.css',async(_req,reply)=>reply.type('text/css').send(factoryCss));
  app.get('/factory/app.js',async(_req,reply)=>reply.type('application/javascript').send(factoryScript));
  app.get('/api/factory',async()=>{
    // No silent restart of expensive work. A retry explicitly keeps the same track and cover.
    await requirePool().query("UPDATE factory_releases SET state='failed',stage='interrupted',error='Сервер перестав передавати прогрес. Можна повторити складання з тими самими матеріалами.',updated_at=NOW() WHERE state='rendering' AND updated_at<NOW()-INTERVAL '30 minutes'");
    await requirePool().query("UPDATE factory_releases SET state='uncertain',error='Передачу перервано. Перевір YouTube Studio перед повторними діями.',updated_at=NOW() WHERE state='publishing' AND updated_at<NOW()-INTERVAL '10 minutes'");
    const db=requirePool();
    const [recipe,assets,releases,counts]=await Promise.all([
      db.query('SELECT * FROM factory_recipe WHERE id=1'),
      db.query(`SELECT * FROM factory_assets ORDER BY created_at DESC LIMIT 300`),
      db.query('SELECT * FROM factory_releases ORDER BY created_at DESC LIMIT 100'),
      db.query(`SELECT vocal,COUNT(*) AS available FROM factory_assets a WHERE kind='audio' AND state='ready' AND NOT EXISTS(SELECT 1 FROM factory_releases r WHERE r.track_id=a.id) GROUP BY vocal`)
    ]);
    return {configured:!!storage,aiConfigured:!!imageGenerator,recipe:recipe.rows[0],effects:EFFECT_CATALOG,assets:assets.rows,releases:releases.rows,availableByVocal:Object.fromEntries(counts.rows.map(r=>[r.vocal,Number(r.available)])),limit:STORAGE_LIMIT,inputLimit:INPUT_LIMIT};
  });
  app.get('/api/factory/storage',async()=>{
    const s=needStorage();
    return factoryLock(async db=>{
      const used=await s.usage();
      const rows=(await db.query('SELECT kind,state,COALESCE(SUM(bytes),0) AS bytes FROM factory_assets GROUP BY kind,state')).rows;
      const reserved=rows.filter(r=>r.state!=='ready').reduce((n,r)=>n+Number(r.bytes),0);
      return {used,reserved,limit:STORAGE_LIMIT,inputLimit:INPUT_LIMIT,breakdown:rows,checkedAt:new Date().toISOString()};
    });
  });
  app.post('/api/factory/recipe',async req=>{
    const body=z.object({vocal,motionIntensity:motionIntensitySchema,coverId:uuid.nullable(),revision:z.number().int().positive()}).strict().parse(req.body);
    if(body.coverId&&!(await requirePool().query("SELECT id FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[body.coverId])).rowCount)throw new FactoryError(400,'Обкладинка ще не збережена.');
    const result=await requirePool().query("UPDATE factory_recipe SET vocal=$1,cover_id=$2,visual_preset='auto',motion_intensity=$3,revision=revision+1 WHERE id=1 AND revision=$4 RETURNING *",[body.vocal,body.coverId,body.motionIntensity,body.revision]);
    if(!result.rowCount)throw new FactoryError(409,'Рецепт змінився в іншій вкладці. Онови сторінку.');
    return result.rows[0];
  });
  app.post('/api/factory/assets',{logLevel:'silent'},async(req,reply)=>{
    const s=needStorage();if(uploading)throw new FactoryError(429,'Дочекайся завершення поточного файла.');uploading=true;
    let dir:string|undefined;
    try{
      const meta=z.object({kind:z.enum(['audio','image']),vocal:vocal.default('instrumental'),theme:z.string().trim().max(500).default('')}).parse(req.query);
      const part=await req.file();if(!part)throw new FactoryError(400,'Обери файл.');
      const data=await part.toBuffer();if(part.file.truncated||data.length>UPLOAD_MAX||data.length<16)throw new FactoryError(400,'Файл має бути до 25 МіБ.');
      const kind=mediaKind(data.subarray(0,16),meta.kind==='image');
      if(meta.kind==='image'&&data.length>8*1024*1024)throw new FactoryError(400,'Обкладинка має бути до 8 МіБ.');
      let duration:number|null=null;
      if(meta.kind==='audio'){
        dir=await mkdtemp(join(tmpdir(),'veil-probe-'));const file=join(dir,'audio.'+kind);await writeFile(file,data);
        if(options.probe)duration=await options.probe(file,kind);
        else {const result=JSON.parse(await runMediaTool(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-max_alloc','67108864','-protocol_whitelist','file,pipe','-f',kind,'-show_entries','format=duration:stream=codec_type','-of','json',file],15000));duration=Number(result.format?.duration);if(!result.streams?.some((v:{codec_type:string})=>v.codec_type==='audio'))duration=0;}
        if(!Number.isFinite(duration)||duration!<1||duration!>300)throw new FactoryError(400,'Перший сценарій приймає треки від 1 секунди до 5 хвилин. Довгі ambient-збірки додамо окремо.');
      }
      const type=meta.kind==='audio'?(kind==='mp3'?'audio/mpeg':'audio/wav'):(kind==='png'?'image/png':'image/jpeg');
      const {asset,fresh}=await reserveAsset(s,{...meta,hash:createHash('sha256').update(data).digest('hex'),name:part.filename.replace(/[<>\x00-\x1f]/g,'').slice(0,150)||'Без назви',bytes:data.length,type,duration});
      if(!fresh){if(asset.state!=='ready')throw new FactoryError(409,'Попереднє збереження цього файла не підтверджене. Він утримує резерв місця; перевір R2 перед повтором.');return {id:asset.id,duplicate:true};}
      try{await s.put(asset.object_key,data,type);await requirePool().query("UPDATE factory_assets SET state='ready' WHERE id=$1",[asset.id]);}
      catch(e){await requirePool().query("UPDATE factory_assets SET state='uncertain' WHERE id=$1",[asset.id]).catch(()=>{});throw e;}
      return reply.code(201).send({id:asset.id,duplicate:false});
    }finally{uploading=false;if(dir)await rm(dir,{recursive:true,force:true});}
  });
  app.get('/api/factory/assets/:id/file',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id);const a=(await requirePool().query("SELECT * FROM factory_assets WHERE id=$1 AND state='ready'",[id])).rows[0];
    if(!a)throw new FactoryError(404,'Файл ще не готовий.');
    const data=await needStorage().get(a.object_key,a.kind==='video'?MAX_OUTPUT_BYTES:UPLOAD_MAX);
    return reply.type(a.type).header('Content-Disposition','inline').send(data);
  });
  const deleteConfirmation=z.object({confirmation:z.literal('DELETE')}).strict();
  const checkedKey=(asset:{id:string;object_key:string})=>{
    if(asset.object_key!==`factory/${asset.id}`)throw new FactoryError(409,'Файл має невідому адресу. Видалення зупинено для безпеки.');
    return asset.object_key;
  };
  const deleteStored=async(s:ObjectStore,asset:{id:string;object_key:string})=>{
    try{await s.delete(checkedKey(asset));}
    catch{throw new FactoryError(503,'R2 не підтвердив видалення. Нічого більше не змінено; спробуй ще раз.');}
  };
  app.post('/api/factory/assets/:id/delete',async(req)=>{
    deleteConfirmation.parse(req.body);const id=uuid.parse((req.params as {id:string}).id),s=needStorage();
    return factoryLock(async db=>{
      const asset=(await db.query('SELECT * FROM factory_assets WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!asset)throw new FactoryError(404,'Матеріал уже видалено.');
      if((await db.query('SELECT id FROM factory_releases WHERE track_id=$1 OR cover_id=$1 OR output_id=$1 LIMIT 1',[id])).rowCount||(await db.query('SELECT release_id FROM factory_release_scenes WHERE asset_id=$1 LIMIT 1',[id])).rowCount)throw new FactoryError(409,'Матеріал використовується у випуску. Спочатку видали відповідний випуск.');
      if((await db.query('SELECT id FROM factory_recipe WHERE cover_id=$1',[id])).rowCount)throw new FactoryError(409,'Цю картинку обрано в рецепті. Спочатку зміни резервну обкладинку в налаштуваннях.');
      await deleteStored(s,asset);await db.query('DELETE FROM factory_assets WHERE id=$1',[id]);
      return {deleted:true,freed:Number(asset.bytes)};
    });
  });
  app.post('/api/factory/releases/:id/delete',async(req)=>{
    deleteConfirmation.parse(req.body);const id=uuid.parse((req.params as {id:string}).id),s=needStorage();
    return factoryLock(async db=>{
      const release=(await db.query('SELECT * FROM factory_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!release)throw new FactoryError(404,'Випуск уже видалено.');
      if(['rendering','publishing','uncertain'].includes(release.state))throw new FactoryError(409,'Цей випуск зараз не можна безпечно видалити. Дочекайся завершення або перевір результат передачі.');
      const output=(await db.query('SELECT * FROM factory_assets WHERE id=$1',[release.output_id])).rows[0];
      const generated=release.recipe?.coverMode==='ai';
      let scenes=generated?(await db.query('SELECT a.* FROM factory_release_scenes s JOIN factory_assets a ON a.id=s.asset_id WHERE s.release_id=$1 ORDER BY s.position',[id])).rows:[];
      if(generated&&!scenes.length){const legacyCover=(await db.query('SELECT * FROM factory_assets WHERE id=$1',[release.cover_id])).rows[0];if(legacyCover)scenes=[legacyCover];}
      const removableScenes=[];
      for(const scene of scenes){const inRecipe=!!(await db.query('SELECT id FROM factory_recipe WHERE cover_id=$1',[scene.id])).rowCount;if(!inRecipe)removableScenes.push(scene);}
      if(output)await deleteStored(s,output);for(const scene of removableScenes)await deleteStored(s,scene);
      await db.query('DELETE FROM factory_releases WHERE id=$1',[id]);
      if(output)await db.query('DELETE FROM factory_assets WHERE id=$1',[output.id]);
      for(const scene of removableScenes)await db.query('DELETE FROM factory_assets WHERE id=$1',[scene.id]);
      return {deleted:true,freed:Number(output?.bytes||0)+removableScenes.reduce((sum,scene)=>sum+Number(scene.bytes||0),0),keptTrackId:release.track_id};
    });
  });
  function work(release:Record<string,any>){
    const task=(async()=>{
      let dir:string|undefined,stage='preparing',progress=Number(release.progress)||2,lastStage='',lastProgress=-1,lastWrite=0;
      let writes=Promise.resolve();
      const update=(nextStage:string,nextProgress:number,detail:string,force=false,media?:{seconds:number;duration:number})=>{
        stage=nextStage;progress=Math.max(progress,Math.min(99,Math.round(nextProgress)));
        const now=Date.now();
        if(!force&&nextStage===lastStage&&progress<=lastProgress&&now-lastWrite<2000)return writes;
        if(!force&&nextStage===lastStage&&progress-lastProgress<1&&now-lastWrite<2000)return writes;
        lastStage=nextStage;lastProgress=progress;lastWrite=now;
        writes=writes.then(async()=>{await requirePool().query("UPDATE factory_releases SET stage=$2,progress=$3,progress_detail=$4,processed_seconds=COALESCE($5,processed_seconds),render_duration=COALESCE($6,render_duration),updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id,nextStage,progress,detail,media?.seconds??null,media?.duration??null]);}).catch(()=>{});
        return writes;
      };
      const failure=(error:unknown)=>{
        if(stage==='generating-image')return 'Workers AI не завершив створення обкладинки. Перевір доступ до Workers AI та повтори з тією самою концепцією.';
        if(stage==='downloading')return 'Не вдалося отримати матеріали з R2. Перевір підключення сховища та повтори.';
        if(stage==='saving-cover'||stage==='uploading')return 'R2 не підтвердив збереження файла. Перевір сховище перед повтором.';
        if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='timeout')return 'Монтаж не вклався у 90 хвилин. Трек і обкладинка збережені; повтор використає ті самі матеріали.';
        if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='aborted')return 'Монтаж перервано зупинкою або перезапуском сервера. Можна повторити з тими самими матеріалами.';
        if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='spawn')return 'FFmpeg не запустився на сервері. Потрібно перевірити інструменти Render.';
        if(stage==='rendering')return 'FFmpeg зупинив монтаж. Трек і обкладинка збережені; повтор використає ті самі матеріали.';
        return 'Виробничу операцію не завершено. Матеріали збережені, тому безпечний повтор не створить нову концепцію.';
      };
      try{
        await update('preparing',3,'Готуємо тимчасове робоче місце.',true);
        const s=needStorage();dir=await mkdtemp(join(tmpdir(),'veil-factory-'));const workDir=dir;
        const get=async(id:string)=>{const a=(await requirePool().query('SELECT * FROM factory_assets WHERE id=$1',[id])).rows[0];if(!a)throw Error('Missing asset');return a;};
        const track=await get(release.track_id),output=await get(release.output_id);
        let scenes=(await requirePool().query(`SELECT s.position,s.label,s.prompt,s.seed,a.id AS asset_id,a.object_key,a.state,a.type FROM factory_release_scenes s JOIN factory_assets a ON a.id=s.asset_id WHERE s.release_id=$1 ORDER BY s.position`,[release.id])).rows;
        if(!scenes.length){const cover=await get(release.cover_id);scenes=[{position:0,label:'Єдина сцена',prompt:release.recipe.prompt,seed:release.recipe.seed,asset_id:cover.id,object_key:cover.object_key,state:cover.state,type:cover.type}];}
        const audio=join(workDir,'audio'),images=scenes.map((_scene,index)=>join(workDir,`scene-${index}`)),video=join(workDir,'video.mp4');
        await update('downloading',7,'Отримуємо музику з приватного сховища R2.',true);
        await writeFile(audio,await s.get(track.object_key,UPLOAD_MAX));
        for(const [index,scene] of scenes.entries()){
          if(scene.state==='ready'){
            await update('downloading',10+index*5,`Отримуємо образ ${index+1} із ${scenes.length} з R2.`,true);
            await writeFile(images[index]!,await s.get(scene.object_key,8*1024*1024));
          }else{
            if(release.recipe.coverMode!=='ai'||!imageGenerator)throw Error('Image generator unavailable');
            await update('generating-image',10+index*6,`Workers AI створює образ ${index+1} із ${scenes.length}: ${scene.label}.`,true);
            const generated=await imageGenerator(scene.prompt,Number(scene.seed),controller.signal);
            await update('saving-cover',14+index*6,`Зберігаємо образ ${index+1} із ${scenes.length} у R2.`,true);
            await s.put(scene.object_key,generated.data,generated.type);await writeFile(images[index]!,generated.data);
            await requirePool().query("UPDATE factory_assets SET state='ready',bytes=$2,type=$3 WHERE id=$1",[scene.asset_id,generated.data.length,generated.type]);
          }
        }
        await requirePool().query("UPDATE factory_releases SET render_started_at=NOW(),processed_seconds=0,render_duration=NULL,updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id]);
        await update('rendering',31,`Запускаємо монтаж V2: ${scenes.length} сцени, атмосфера і звук.`,true);
        const renderEffects=(release.recipe.productionPlan?.effects??ACTIVE_EFFECT_IDS).filter((id:string)=>id!=='camera.center-push');
        await (options.render??renderMedia)(images,audio,video,track.type==='audio/wav'?'wav':'mp3',controller.signal,'video',release.recipe.visualPreset,p=>{
          const processed=Math.min(p.duration,p.seconds),overall=31+p.percent*.57;
          const clock=(seconds:number)=>Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');
          void update('rendering',overall,'Змонтовано '+clock(processed)+' із '+clock(p.duration)+' музики.',false,{seconds:processed,duration:p.duration});
        },release.recipe.motionIntensity||'cinematic',renderEffects);
        await update('verifying',91,'Перевіряємо тривалість, звук, роздільність і розмір відео.',true);
        const result=await readFile(video);if(result.length>MAX_OUTPUT_BYTES)throw Error('Output exceeds reservation');
        await update('uploading',96,'Передаємо готове відео до приватного сховища R2.',true);
        await s.put(output.object_key,result,'video/mp4');
        await writes;
        await factoryLock(async db=>{
          await db.query("UPDATE factory_assets SET state='ready',bytes=$2 WHERE id=$1",[output.id,result.length]);
          await db.query("UPDATE factory_releases SET state='review',stage='complete',progress=100,progress_detail='Відео готове до твоєї перевірки.',error=NULL,updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id]);
        });
      }catch(error){
        await writes;
        const reason=error instanceof MediaToolError?error.reason:'operation';
        app.log.error({releaseId:release.id,stage,reason},'Factory release failed');
        await requirePool().query("UPDATE factory_releases SET state='failed',stage=$2,progress=$3,progress_detail='Зупинено на цьому етапі.',error=$4,updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id,stage,progress,failure(error)]).catch(()=>{});
      }finally{if(dir)await rm(dir,{recursive:true,force:true});}
    })();tasks.add(task);void task.finally(()=>tasks.delete(task));
  }
  app.post('/api/factory/releases',async(req,reply)=>{
    const {requestKey}=z.object({requestKey:uuid}).strict().parse(req.body);
    const s=needStorage();if(!options.render)await checkMediaTools();
    const {release,fresh}=await startRelease(s,requestKey,!!imageGenerator);if(fresh)work(release);
    return reply.code(fresh?202:200).send({id:release.id,state:release.state});
  });
  app.post('/api/factory/releases/:id/retry',async(req,reply)=>{
    needStorage();const id=uuid.parse((req.params as {id:string}).id);
    const release=await factoryLock(async db=>{
      if((await db.query("SELECT id FROM factory_releases WHERE state='rendering'")).rowCount)throw new FactoryError(409,'Лінія зайнята.');
      const r=(await db.query("UPDATE factory_releases SET state='rendering',stage='preparing',progress=2,progress_detail='Готуємо безпечний повтор із тими самими матеріалами.',error=NULL,started_at=NOW(),render_started_at=NULL,processed_seconds=NULL,render_duration=NULL,updated_at=NOW() WHERE id=$1 AND state='failed' RETURNING *",[id])).rows[0];
      if(!r)throw new FactoryError(409,'Повтор доступний лише для невдалого складання.');return r;
    });work(release);return reply.code(202).send({id});
  });
  app.post('/api/factory/releases/:id/publish',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const meta=z.object({children:z.enum(['yes','no']),synthetic:z.enum(['yes','no']),rights:z.literal(true)}).strict().parse(req.body);
    const release=(await requirePool().query("UPDATE factory_releases SET state='publishing',updated_at=NOW() WHERE id=$1 AND state='review' RETURNING *",[id])).rows[0];
    if(!release)throw new FactoryError(409,'Випуск не готовий або вже передавався. Не повторюй невідоме завантаження без перевірки YouTube.');
    try{
      const a=(await requirePool().query('SELECT * FROM factory_assets WHERE id=$1',[release.output_id])).rows[0];
      const file=await needStorage().get(a.object_key,MAX_OUTPUT_BYTES);
      const result=await app.inject({method:'POST',url:'/youtube/upload?'+new URLSearchParams({title:release.title,children:meta.children,synthetic:meta.synthetic}),headers:{cookie:req.headers.cookie??'',origin:ownerOrigin(),'content-type':'video/mp4'},payload:file});
      const data=result.json();if(result.statusCode!==200||!data.videoId)throw Error('Upload not confirmed');
      await requirePool().query("UPDATE factory_releases SET state='private',video_id=$2,updated_at=NOW() WHERE id=$1",[id,data.videoId]);return {videoId:data.videoId};
    }catch{
      await requirePool().query("UPDATE factory_releases SET state='uncertain',error='Передачу не підтверджено. Перевір YouTube Studio; автоматичний повтор заблоковано.',updated_at=NOW() WHERE id=$1",[id]);
      return reply.code(502).send({error:'Перевір YouTube Studio перед повторними діями. Результат передачі невідомий.'});
    }
  });
}
