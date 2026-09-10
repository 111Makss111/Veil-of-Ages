import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { requirePool } from './db.js';
import { ownerOrigin } from './owner-auth.js';
import { mediaKind, renderMedia, runMediaTool, checkMediaTools, MAX_OUTPUT_BYTES } from './media-render.js';
import { createObjectStore, STORAGE_LIMIT, INPUT_LIMIT, type ObjectStore } from './factory-storage.js';
import { FactoryError, reserveAsset, startRelease, factoryLock } from './factory-store.js';
import { factoryPage, factoryCss, factoryScript } from './factory-ui.js';
import { createCloudflareImageGenerator, type ImageGenerator } from './factory-ai.js';

const uuid=z.string().uuid();
const vocal=z.enum(['instrumental','choir']);
const visualPreset=z.enum(['auto','ancient-mist','ember-glow','moonlit-ruins']);
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
    await requirePool().query("UPDATE factory_releases SET state='failed',error='Обробку перервано. Можна повторити складання з тими самими матеріалами.',updated_at=NOW() WHERE state='rendering' AND updated_at<NOW()-INTERVAL '30 minutes'");
    await requirePool().query("UPDATE factory_releases SET state='uncertain',error='Передачу перервано. Перевір YouTube Studio перед повторними діями.',updated_at=NOW() WHERE state='publishing' AND updated_at<NOW()-INTERVAL '10 minutes'");
    const db=requirePool();
    const [recipe,assets,releases,counts]=await Promise.all([
      db.query('SELECT * FROM factory_recipe WHERE id=1'),
      db.query(`SELECT a.*,r.id AS release_id,r.state AS release_state FROM factory_assets a LEFT JOIN factory_releases r ON r.track_id=a.id WHERE a.kind<>'video' ORDER BY a.created_at DESC LIMIT 200`),
      db.query('SELECT * FROM factory_releases ORDER BY created_at DESC LIMIT 100'),
      db.query(`SELECT vocal,COUNT(*) AS available FROM factory_assets a WHERE kind='audio' AND state='ready' AND NOT EXISTS(SELECT 1 FROM factory_releases r WHERE r.track_id=a.id) GROUP BY vocal`)
    ]);
    return {configured:!!storage,aiConfigured:!!imageGenerator,recipe:recipe.rows[0],assets:assets.rows,releases:releases.rows,availableByVocal:Object.fromEntries(counts.rows.map(r=>[r.vocal,Number(r.available)])),limit:STORAGE_LIMIT,inputLimit:INPUT_LIMIT};
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
    const body=z.object({vocal,visualPreset,coverId:uuid.nullable(),revision:z.number().int().positive()}).strict().parse(req.body);
    if(body.coverId&&!(await requirePool().query("SELECT id FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[body.coverId])).rowCount)throw new FactoryError(400,'Обкладинка ще не збережена.');
    const result=await requirePool().query('UPDATE factory_recipe SET vocal=$1,cover_id=$2,visual_preset=$3,revision=revision+1 WHERE id=1 AND revision=$4 RETURNING *',[body.vocal,body.coverId,body.visualPreset,body.revision]);
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
    const data=await needStorage().get(a.object_key,UPLOAD_MAX);
    return reply.type(a.type).header('Content-Disposition','inline').send(data);
  });
  function work(release:Record<string,any>){
    const task=(async()=>{
      let dir:string|undefined;
      try{
        const s=needStorage();dir=await mkdtemp(join(tmpdir(),'veil-factory-'));
        const get=async(id:string)=>{const a=(await requirePool().query('SELECT * FROM factory_assets WHERE id=$1',[id])).rows[0];if(!a)throw Error('Missing asset');return a;};
        const track=await get(release.track_id),cover=await get(release.cover_id),output=await get(release.output_id);
        const audio=join(dir,'audio'),image=join(dir,'image'),video=join(dir,'video.mp4');
        await writeFile(audio,await s.get(track.object_key,UPLOAD_MAX));
        if(cover.state==='ready')await writeFile(image,await s.get(cover.object_key,8*1024*1024));
        else{
          if(release.recipe.coverMode!=='ai'||!imageGenerator)throw Error('Image generator unavailable');
          const generated=await imageGenerator(release.recipe.prompt,release.recipe.seed,controller.signal);
          await s.put(cover.object_key,generated.data,generated.type);await writeFile(image,generated.data);
          await requirePool().query("UPDATE factory_assets SET state='ready',bytes=$2,type=$3 WHERE id=$1",[cover.id,generated.data.length,generated.type]);
        }
        await (options.render??renderMedia)(image,audio,video,track.type==='audio/wav'?'wav':'mp3',controller.signal,'video',release.recipe.visualPreset);
        const result=await readFile(video);if(result.length>MAX_OUTPUT_BYTES)throw Error('Output exceeds reservation');
        await s.put(output.object_key,result,'video/mp4');
        await factoryLock(async db=>{
          await db.query("UPDATE factory_assets SET state='ready',bytes=$2 WHERE id=$1",[output.id,result.length]);
          await db.query("UPDATE factory_releases SET state='review',error=NULL,updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id]);
        });
      }catch{
        await requirePool().query("UPDATE factory_releases SET state='failed',error='Складання не завершено. Перевір Workers AI, R2 та FFmpeg; повтор використає той самий трек, концепцію і seed.',updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id]).catch(()=>{});
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
      const r=(await db.query("UPDATE factory_releases SET state='rendering',error=NULL,updated_at=NOW() WHERE id=$1 AND state='failed' RETURNING *",[id])).rows[0];
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
