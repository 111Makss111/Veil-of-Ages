import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { requirePool } from './db.js';
import { ownerOrigin } from './owner-auth.js';
import { mediaKind, renderMedia, runMediaTool, checkMediaTools, MAX_OUTPUT_BYTES, MediaToolError } from './media-render.js';
import { createObjectStore, STORAGE_LIMIT, INPUT_LIMIT, type ObjectStore } from './factory-storage.js';
import { FactoryError, reserveAsset, startRelease, factoryLock, capacity } from './factory-store.js';
import { factoryPage, factoryCss, factoryScript } from './factory-ui.js';
import { factoryChannelCss } from './factory-channel-ui.js';
import { createPreferredImageGenerator, imageGeneratorProvider, type ImageGenerator } from './factory-ai.js';
import { ACTIVE_EFFECT_IDS, EFFECT_CATALOG, motionIntensitySchema } from './factory-effects.js';
import { approveSongIdea, createSongIdea, textGeneratorConfigured, textGeneratorProvider } from './factory-song.js';
import { songMode, songPackageSchema } from './factory-song-domain.js';
import { buildShortsArtwork, buildYoutubeThumbnail } from './factory-thumbnail.js';

const uuid=z.string().uuid();
const vocal=z.enum(['instrumental','choir']);
const containerId=z.string().regex(/^[a-z0-9-]{2,40}$/);
const UPLOAD_MAX=25*1024*1024;
const SHORTS_MAX_BYTES=16*1024*1024;
export async function factoryRoutes(app: FastifyInstance, options: { storage?: ObjectStore; render?: typeof renderMedia; probe?: (file: string, kind: string) => Promise<number>; imageGenerator?: ImageGenerator|null } = {}) {
  const storage=options.storage ?? createObjectStore();
  const imageGenerator=options.imageGenerator===undefined?createPreferredImageGenerator():options.imageGenerator;
  const configuredImageProvider=options.imageGenerator===undefined?imageGeneratorProvider():options.imageGenerator?'Генератор образів':null;
  const tasks=new Set<Promise<void>>();const jobs=new Map<string,AbortController>();let uploading=false;
  const needStorage=()=>{if(!storage)throw new FactoryError(503,'Підключи приватне сховище R2 в Render. Файли ще не завантажуються.');return storage;};
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin')
      .header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(!req.ownerSession?.verified)return reply.code(401).send({error:'Увійди в кабінет і підтвердь Authenticator.'});
    if(req.method==='POST'&&req.headers.origin!==ownerOrigin())return reply.code(403).send({error:'Відкрий фабрику зі свого кабінету.'});
  });
  app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof FactoryError?e.status:e instanceof z.ZodError?400:503).send({error:e instanceof FactoryError?e.message:e instanceof z.ZodError?'Перевір заповнені поля.':'Операцію не підтверджено. Онови стан перед повтором. Перевір підключення R2 та бази.'}));
  await app.register(multipart,{limits:{files:1,fields:0,parts:1,fileSize:UPLOAD_MAX}});
  app.addHook('onClose',async()=>{for(const controller of jobs.values())controller.abort();await Promise.allSettled([...tasks]);});
  app.get('/factory',async(_req,reply)=>reply.type('text/html').send(factoryPage));
  app.get('/factory/style.css',async(_req,reply)=>reply.type('text/css').send(factoryCss+factoryChannelCss));
  app.get('/factory/app.js',async(_req,reply)=>reply.type('application/javascript').send(factoryScript));
  app.get('/api/factory',async()=>{
    // No silent restart of expensive work. A retry explicitly keeps the same track and cover.
    await requirePool().query("UPDATE factory_releases SET state='failed',stage='interrupted',error='Сервер перестав передавати прогрес. Можна повторити складання з тими самими матеріалами.',updated_at=NOW() WHERE state='rendering' AND updated_at<NOW()-INTERVAL '30 minutes'");
    await requirePool().query("UPDATE factory_releases SET state='uncertain',error='Передачу перервано. Перевір YouTube Studio перед повторними діями.',updated_at=NOW() WHERE state='publishing' AND updated_at<NOW()-INTERVAL '10 minutes'");
    await requirePool().query("UPDATE factory_releases SET short_publish_state='uncertain',short_publish_error='Передачу Shorts перервано. Перевір YouTube Studio перед повторними діями.',updated_at=NOW() WHERE short_publish_state='publishing' AND updated_at<NOW()-INTERVAL '10 minutes'");
    await requirePool().query("UPDATE factory_releases SET short_state='failed',short_error='Створення Shorts перервав перезапуск сервера. Можна безпечно повторити.',short_updated_at=NOW() WHERE short_state='rendering' AND short_updated_at<NOW()-INTERVAL '30 minutes'");
    await requirePool().query("UPDATE factory_song_ideas SET state='failed',error='Генерацію перервав перезапуск сервера. Запусти створення тексту ще раз.',updated_at=NOW() WHERE state='generating' AND updated_at<NOW()-INTERVAL '3 minutes'");
    const db=requirePool();
    const [recipe,assets,releases,counts,channels,containers,channelContainers,ideas]=await Promise.all([
      db.query('SELECT * FROM factory_recipe WHERE id=1'),
      db.query(`SELECT a.*,c.name AS container_name FROM factory_assets a LEFT JOIN factory_containers c ON c.id=a.container_id ORDER BY a.created_at DESC LIMIT 300`),
      db.query('SELECT * FROM factory_releases ORDER BY created_at DESC LIMIT 100'),
      db.query(`SELECT cc.channel_id,a.vocal,COUNT(*) AS available FROM factory_assets a JOIN factory_channel_containers cc ON cc.container_id=a.container_id WHERE a.kind='audio' AND a.state='ready' AND NOT EXISTS(SELECT 1 FROM factory_releases r WHERE r.track_id=a.id) GROUP BY cc.channel_id,a.vocal`),
      db.query('SELECT * FROM factory_channels WHERE active=TRUE ORDER BY created_at,id'),
      db.query('SELECT * FROM factory_containers ORDER BY position,name'),
      db.query('SELECT channel_id,container_id FROM factory_channel_containers ORDER BY channel_id,container_id'),
      db.query('SELECT * FROM factory_song_ideas ORDER BY created_at DESC LIMIT 20')
    ]);
    const availableByChannel:Record<string,Record<string,number>>={};for(const r of counts.rows)(availableByChannel[r.channel_id]??={})[r.vocal]=Number(r.available);
    return {configured:!!storage,aiConfigured:!!imageGenerator,imageAiProvider:configuredImageProvider,textAiConfigured:textGeneratorConfigured(),textAiProvider:textGeneratorProvider(),recipe:recipe.rows[0],effects:EFFECT_CATALOG,assets:assets.rows,releases:releases.rows,ideas:ideas.rows,channels:channels.rows,containers:containers.rows,channelContainers:channelContainers.rows,availableByChannel,availableByVocal:Object.fromEntries(counts.rows.filter(r=>r.channel_id==='veil-of-ages').map(r=>[r.vocal,Number(r.available)])),limit:STORAGE_LIMIT,inputLimit:INPUT_LIMIT};
  });
  app.post('/api/factory/ideas',{bodyLimit:5000,logLevel:'silent'},async req=>{
    const body=z.object({channelId:containerId.default('veil-of-ages'),mode:songMode,brief:z.string().trim().max(3000).default('')}).strict().parse(req.body);
    return createSongIdea(body.channelId,body.mode,body.brief,AbortSignal.timeout(90000));
  });
  app.post('/api/factory/ideas/:id/approve',async req=>approveSongIdea(uuid.parse((req.params as {id:string}).id)));
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
    const body=z.object({vocal,motionIntensity:motionIntensitySchema,coverId:uuid.nullable(),containerIds:z.array(containerId).min(1).max(12).optional(),revision:z.number().int().positive()}).strict().parse(req.body);
    if(body.coverId&&!(await requirePool().query("SELECT id FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[body.coverId])).rowCount)throw new FactoryError(400,'Обкладинка ще не збережена.');
    return factoryLock(async db=>{const current=(await db.query('SELECT * FROM factory_recipe WHERE id=1 FOR UPDATE')).rows[0];if(!current||current.revision!==body.revision)throw new FactoryError(409,'Рецепт змінився в іншій вкладці. Онови сторінку.');if(body.containerIds){const valid=await db.query('SELECT id FROM factory_containers WHERE id=ANY($1::text[])',[body.containerIds]);if(valid.rows.length!==new Set(body.containerIds).size)throw new FactoryError(400,'Один із жанрових контейнерів не існує.');await db.query('DELETE FROM factory_channel_containers WHERE channel_id=$1',[current.channel_id]);for(const id of new Set(body.containerIds))await db.query('INSERT INTO factory_channel_containers(channel_id,container_id) VALUES($1,$2)',[current.channel_id,id]);}return (await db.query("UPDATE factory_recipe SET vocal=$1,cover_id=$2,visual_preset='auto',motion_intensity=$3,revision=revision+1 WHERE id=1 RETURNING *",[body.vocal,body.coverId,body.motionIntensity])).rows[0];});
  });
  app.post('/api/factory/assets',{logLevel:'silent'},async(req,reply)=>{
    const s=needStorage();if(uploading)throw new FactoryError(429,'Дочекайся завершення поточного файла.');uploading=true;
    let dir:string|undefined;
    try{
      const requested=z.object({kind:z.enum(['audio','image']),vocal:vocal.default('instrumental'),containerId:containerId.default('viking-anthem'),theme:z.string().trim().max(2000).default(''),ideaId:uuid.optional()}).parse(req.query);
      let meta:{kind:'audio'|'image';vocal:'instrumental'|'choir';containerId:string;theme:string}={...requested,theme:requested.theme.slice(0,500)};
      let idea:{id:string;mode:'viking-anthem'|'viking-rap-duet';content:unknown;audio_id:string|null}|null=null;
      if(requested.ideaId){
        if(requested.kind!=='audio')throw new FactoryError(400,'До задуму можна прикріпити лише готову пісню.');
        idea=(await requirePool().query("SELECT id,mode,content,audio_id FROM factory_song_ideas WHERE id=$1 AND state='approved'",[requested.ideaId])).rows[0]||null;
        if(!idea)throw new FactoryError(409,'Спочатку затвердь назву та слова.');if(idea.audio_id)throw new FactoryError(409,'До цього задуму вже додано готову пісню.');
        const content=songPackageSchema.parse(idea.content);meta={kind:'audio',vocal:'choir',containerId:idea.mode,theme:content.concept.slice(0,500)};
      }
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
      if(meta.kind==='audio'&&!(await requirePool().query('SELECT id FROM factory_containers WHERE id=$1',[meta.containerId])).rowCount)throw new FactoryError(400,'Обраний жанровий контейнер не існує.');
      const type=meta.kind==='audio'?(kind==='mp3'?'audio/mpeg':'audio/wav'):(kind==='png'?'image/png':'image/jpeg');
      const originalName=part.filename.replace(/[<>\x00-\x1f]/g,'').slice(0,150)||'Без назви';
      const content=idea?songPackageSchema.parse(idea.content):null;
      const savedName=content?content.title.replace(/[<>\x00-\x1f]/g,'').slice(0,135)+(kind==='mp3'?'.mp3':'.wav'):originalName;
      const {asset,fresh}=await reserveAsset(s,{...meta,hash:createHash('sha256').update(data).digest('hex'),name:savedName,bytes:data.length,type,duration});
      if(!fresh){
        if(idea&&((await requirePool().query('SELECT id FROM factory_song_ideas WHERE audio_id=$1 AND id<>$2',[asset.id,idea.id])).rowCount||(await requirePool().query('SELECT id FROM factory_releases WHERE track_id=$1',[asset.id])).rowCount))throw new FactoryError(409,'Цей аудіофайл уже належить іншому запуску.');
        if(asset.state!=='ready'){
          // A browser or service restart can lose the response after reservation. Repeating
          // the same file safely overwrites the same R2 key instead of trapping the song.
          try{await s.put(asset.object_key,data,type);await requirePool().query("UPDATE factory_assets SET state='ready',bytes=$2,type=$3,duration=$4 WHERE id=$1",[asset.id,data.length,type,duration]);}
          catch(e){await requirePool().query("UPDATE factory_assets SET state='uncertain' WHERE id=$1",[asset.id]).catch(()=>{});throw e;}
        }
        if(idea)await requirePool().query('UPDATE factory_song_ideas SET audio_id=$2,updated_at=NOW() WHERE id=$1',[idea.id,asset.id]);
        return {id:asset.id,duplicate:true,recovered:asset.state!=='ready',ideaId:idea?.id||null};
      }
      try{await s.put(asset.object_key,data,type);await requirePool().query("UPDATE factory_assets SET state='ready' WHERE id=$1",[asset.id]);}
      catch(e){await requirePool().query("UPDATE factory_assets SET state='uncertain' WHERE id=$1",[asset.id]).catch(()=>{});throw e;}
      if(idea)await requirePool().query('UPDATE factory_song_ideas SET audio_id=$2,updated_at=NOW() WHERE id=$1',[idea.id,asset.id]);
      return reply.code(201).send({id:asset.id,duplicate:false,containerId:asset.container_id,ideaId:idea?.id||null});
    }finally{uploading=false;if(dir)await rm(dir,{recursive:true,force:true});}
  });
  app.get('/api/factory/assets/:id/file',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id);const a=(await requirePool().query("SELECT * FROM factory_assets WHERE id=$1 AND state='ready'",[id])).rows[0];
    if(!a)throw new FactoryError(404,'Файл ще не готовий.');
    const data=await needStorage().get(a.object_key,a.kind==='video'?MAX_OUTPUT_BYTES:UPLOAD_MAX);
    return reply.type(a.type).header('Content-Disposition','inline').send(data);
  });
  app.get('/api/factory/releases/:id/thumbnail',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id),release=(await requirePool().query('SELECT id,title,cover_id FROM factory_releases WHERE id=$1',[id])).rows[0];
    if(!release)throw new FactoryError(404,'Випуск не знайдено.');
    const cover=(await requirePool().query("SELECT object_key FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[release.cover_id])).rows[0];
    if(!cover)throw new FactoryError(409,'Обкладинка ще створюється.');
    const thumbnail=await buildYoutubeThumbnail(await needStorage().get(cover.object_key,8*1024*1024),release.title);
    return reply.type('image/jpeg').header('Content-Disposition','inline').send(thumbnail);
  });
  app.get('/api/factory/releases/:id/shorts-poster',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id),release=(await requirePool().query('SELECT id,title,cover_id FROM factory_releases WHERE id=$1',[id])).rows[0];
    if(!release)throw new FactoryError(404,'Випуск не знайдено.');
    const cover=(await requirePool().query("SELECT object_key FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[release.cover_id])).rows[0];
    if(!cover)throw new FactoryError(409,'Обкладинка ще створюється.');
    return reply.type('image/jpeg').header('Content-Disposition','inline').send(await buildShortsArtwork(await needStorage().get(cover.object_key,8*1024*1024),release.title));
  });
  const attachYoutubeThumbnail=async(release:{id:string;title:string;cover_id:string},videoId:string,cookie:string)=>{
    const cover=(await requirePool().query("SELECT object_key FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[release.cover_id])).rows[0];
    if(!cover)throw new FactoryError(409,'Обкладинка випуску не знайдена.');
    const source=await needStorage().get(cover.object_key,8*1024*1024);
    const thumbnail=await buildYoutubeThumbnail(source,release.title);
    const result=await app.inject({method:'POST',url:'/youtube/thumbnail?'+new URLSearchParams({videoId}),headers:{cookie,origin:ownerOrigin(),'content-type':'image/jpeg'},payload:thumbnail});
    const data=result.json() as {error?:string};
    if(result.statusCode!==200)throw new FactoryError(result.statusCode===502?502:409,data.error||'YouTube не підтвердив власну обкладинку.');
  };
  app.post('/api/factory/releases/:id/thumbnail',{logLevel:'silent'},async(req)=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const release=(await requirePool().query("SELECT id,title,cover_id,video_id,state FROM factory_releases WHERE id=$1",[id])).rows[0];
    if(!release)throw new FactoryError(404,'Випуск не знайдено.');
    if(release.state!=='private'||!release.video_id)throw new FactoryError(409,'Спочатку відео має бути приватно завантажене на YouTube.');
    try{await attachYoutubeThumbnail(release,release.video_id,req.headers.cookie??'');}
    catch(error){const message=error instanceof FactoryError?error.message:'YouTube не підтвердив власну обкладинку.';await requirePool().query('UPDATE factory_releases SET error=$2,updated_at=NOW() WHERE id=$1',[id,message]);throw error;}
    await requirePool().query('UPDATE factory_releases SET error=NULL,updated_at=NOW() WHERE id=$1',[id]);
    return {thumbnailSet:true};
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
      if((await db.query('SELECT id FROM factory_releases WHERE track_id=$1 OR cover_id=$1 OR output_id=$1 OR short_output_id=$1 LIMIT 1',[id])).rowCount||(await db.query('SELECT release_id FROM factory_release_scenes WHERE asset_id=$1 LIMIT 1',[id])).rowCount)throw new FactoryError(409,'Матеріал використовується у випуску. Спочатку видали відповідний випуск.');
      if((await db.query('SELECT id FROM factory_recipe WHERE cover_id=$1',[id])).rowCount)throw new FactoryError(409,'Цю картинку обрано в рецепті. Спочатку зміни резервну обкладинку в налаштуваннях.');
      await deleteStored(s,asset);await db.query('UPDATE factory_song_ideas SET audio_id=NULL,updated_at=NOW() WHERE audio_id=$1',[id]);await db.query('DELETE FROM factory_assets WHERE id=$1',[id]);
      return {deleted:true,freed:Number(asset.bytes)};
    });
  });
  app.post('/api/factory/releases/:id/delete',async(req)=>{
    deleteConfirmation.parse(req.body);const id=uuid.parse((req.params as {id:string}).id),s=needStorage();
    return factoryLock(async db=>{
      const release=(await db.query('SELECT * FROM factory_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!release)throw new FactoryError(404,'Випуск уже видалено.');
      if(['rendering','publishing','uncertain'].includes(release.state)||release.short_state==='rendering'||['publishing','uncertain'].includes(release.short_publish_state))throw new FactoryError(409,'Цей випуск зараз не можна безпечно видалити. Дочекайся завершення або перевір результат передачі.');
      const output=(await db.query('SELECT * FROM factory_assets WHERE id=$1',[release.output_id])).rows[0];
      const shortOutput=release.short_output_id?(await db.query('SELECT * FROM factory_assets WHERE id=$1',[release.short_output_id])).rows[0]:null;
      const generated=release.recipe?.coverMode==='ai';
      let scenes=generated?(await db.query('SELECT a.* FROM factory_release_scenes s JOIN factory_assets a ON a.id=s.asset_id WHERE s.release_id=$1 ORDER BY s.position',[id])).rows:[];
      if(generated&&!scenes.length){const legacyCover=(await db.query('SELECT * FROM factory_assets WHERE id=$1',[release.cover_id])).rows[0];if(legacyCover)scenes=[legacyCover];}
      const removableScenes=[];
      for(const scene of scenes){const inRecipe=!!(await db.query('SELECT id FROM factory_recipe WHERE cover_id=$1',[scene.id])).rowCount;if(!inRecipe)removableScenes.push(scene);}
      if(output)await deleteStored(s,output);if(shortOutput)await deleteStored(s,shortOutput);for(const scene of removableScenes)await deleteStored(s,scene);
      await db.query('DELETE FROM factory_releases WHERE id=$1',[id]);
      if(output)await db.query('DELETE FROM factory_assets WHERE id=$1',[output.id]);
      if(shortOutput)await db.query('DELETE FROM factory_assets WHERE id=$1',[shortOutput.id]);
      for(const scene of removableScenes)await db.query('DELETE FROM factory_assets WHERE id=$1',[scene.id]);
      return {deleted:true,freed:Number(output?.bytes||0)+Number(shortOutput?.bytes||0)+removableScenes.reduce((sum,scene)=>sum+Number(scene.bytes||0),0),keptTrackId:release.track_id};
    });
  });
  function workShort(release:Record<string,any>){
    const controller=new AbortController();jobs.set(release.id,controller);
    const task=(async()=>{let dir:string|undefined,lastWrite=0;
      const progress=(value:number)=>{const now=Date.now();if(value<99&&now-lastWrite<1500)return;lastWrite=now;void requirePool().query("UPDATE factory_releases SET short_progress=$2,short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id,Math.max(1,Math.min(99,Math.round(value)))]).catch(()=>{});};
      try{
        const s=needStorage();dir=await mkdtemp(join(tmpdir(),'veil-shorts-'));
        const [track,cover,output]=await Promise.all([
          requirePool().query("SELECT * FROM factory_assets WHERE id=$1 AND kind='audio' AND state='ready'",[release.track_id]).then(r=>r.rows[0]),
          requirePool().query("SELECT * FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[release.cover_id]).then(r=>r.rows[0]),
          requirePool().query("SELECT * FROM factory_assets WHERE id=$1",[release.short_output_id]).then(r=>r.rows[0])
        ]);
        if(!track||!cover||!output)throw Error('Missing Shorts material');
        const audio=join(dir,'audio'),image=join(dir,'shorts.jpg'),video=join(dir,'shorts.mp4');
        const [audioData,coverData]=await Promise.all([s.get(track.object_key,UPLOAD_MAX),s.get(cover.object_key,8*1024*1024)]);
        await Promise.all([writeFile(audio,audioData),buildShortsArtwork(coverData,release.title).then(data=>writeFile(image,data))]);
        progress(8);
        await (options.render??renderMedia)(image,audio,video,track.type==='audio/wav'?'wav':'mp3',controller.signal,'shorts',release.recipe.visualPreset,p=>progress(10+p.percent*.82),'cinematic',ACTIVE_EFFECT_IDS.filter(id=>id!=='story.three-scenes'&&id!=='transition.scene-crossfades'&&id!=='camera.center-push'));
        const result=await readFile(video);if(result.length>SHORTS_MAX_BYTES)throw Error('Shorts exceeds reservation');
        progress(94);await s.put(output.object_key,result,'video/mp4');
        await factoryLock(async db=>{await db.query("UPDATE factory_assets SET state='ready',bytes=$2 WHERE id=$1",[output.id,result.length]);await db.query("UPDATE factory_releases SET short_state='review',short_progress=100,short_error=NULL,short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id]);});
      }catch(error){app.log.error({releaseId:release.id},'Factory Shorts failed');await requirePool().query("UPDATE factory_releases SET short_state='failed',short_error='Не вдалося скласти Shorts. Матеріали збережено — можна повторити без генерації нової картинки.',short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id]).catch(()=>{});}
      finally{if(jobs.get(release.id)===controller)jobs.delete(release.id);if(dir)await rm(dir,{recursive:true,force:true});}
    })();tasks.add(task);void task.finally(()=>tasks.delete(task));
  }
  app.post('/api/factory/releases/:id/shorts',async(req,reply)=>{
    needStorage();if(!options.render)await checkMediaTools();const id=uuid.parse((req.params as {id:string}).id);
    const {release,fresh}=await factoryLock(async db=>{
      if((await db.query("SELECT id FROM factory_releases WHERE state='rendering' OR short_state='rendering'")).rowCount)throw new FactoryError(409,'Лінія вже монтує відео. Дочекайся завершення.');
      const current=(await db.query('SELECT * FROM factory_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!current||!['review','private'].includes(current.state))throw new FactoryError(409,'Shorts можна створити лише для готового повного випуску.');
      if(current.short_state==='review')return {release:current,fresh:false};
      let outputId=current.short_output_id;
      if(!outputId){await capacity(db,needStorage(),SHORTS_MAX_BYTES);outputId=randomUUID();await db.query("INSERT INTO factory_assets(id,kind,hash,object_key,name,bytes,type,vocal,state) VALUES($1,'video',$2,$3,$4,$5,'video/mp4',$6,'reserved')",[outputId,'short:'+current.id,'factory/'+outputId,current.title+' · Shorts.mp4',SHORTS_MAX_BYTES,current.recipe.vocal]);}
      const updated=(await db.query("UPDATE factory_releases SET short_output_id=$2,short_state='rendering',short_progress=1,short_error=NULL,short_started_at=NOW(),short_updated_at=NOW() WHERE id=$1 RETURNING *",[id,outputId])).rows[0];return {release:updated,fresh:true};
    });
    if(fresh)workShort(release);return reply.code(fresh?202:200).send({id,shortState:release.short_state});
  });
  app.post('/api/factory/releases/:id/cancel',async req=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const mode=await factoryLock(async db=>{
      const release=(await db.query('SELECT state,short_state FROM factory_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!release)throw new FactoryError(404,'Випуск не знайдено.');
      if(release.state==='rendering'){await db.query("UPDATE factory_releases SET state='failed',stage='interrupted',progress_detail='Процес скасовано вручну.',error='Монтаж скасовано. Можна повторити з одним образом і тими самими матеріалами.',updated_at=NOW() WHERE id=$1",[id]);return 'video';}
      if(release.short_state==='rendering'){await db.query("UPDATE factory_releases SET short_state='failed',short_error='Створення Shorts скасовано. Можна безпечно повторити.',short_updated_at=NOW() WHERE id=$1",[id]);return 'shorts';}
      throw new FactoryError(409,'Активного процесу для скасування немає.');
    });
    jobs.get(id)?.abort();return {cancelled:true,mode};
  });
  function work(release:Record<string,any>){
    const controller=new AbortController();jobs.set(release.id,controller);
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
        if(stage==='generating-image')return error instanceof Error&&/^(OpenAI|Workers AI|Генерац)/.test(error.message)?error.message:'Генератор не завершив створення обкладинки. Перевір доступ до OpenAI та повтори з тією самою концепцією.';
        if(stage==='downloading')return 'Не вдалося отримати матеріали з R2. Перевір підключення сховища та повтори.';
        if(stage==='saving-cover'||stage==='uploading')return 'R2 не підтвердив збереження файла. Перевір сховище перед повтором.';
      if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='timeout')return 'Монтаж не вклався у 90 хвилин. Трек і обкладинка збережені; повтор використає ті самі матеріали.';
      if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='stalled')return 'FFmpeg не передавав нового прогресу понад 5 хвилин, тому завислий монтаж безпечно зупинено. Повтор використає один образ і ті самі матеріали.';
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
        scenes=scenes.slice(0,Math.max(1,Math.min(3,Number(release.recipe?.productionPlan?.sceneCount)||1)));
        const audio=join(workDir,'audio'),images=scenes.map((_scene,index)=>join(workDir,`scene-${index}`)),video=join(workDir,'video.mp4');
        await update('downloading',7,'Отримуємо музику з приватного сховища R2.',true);
        await writeFile(audio,await s.get(track.object_key,UPLOAD_MAX));
        for(const [index,scene] of scenes.entries()){
          if(scene.state==='ready'){
            await update('downloading',10+index*5,`Отримуємо образ ${index+1} із ${scenes.length} з R2.`,true);
            await writeFile(images[index]!,await s.get(scene.object_key,8*1024*1024));
          }else{
            if(release.recipe.coverMode!=='ai'||!imageGenerator)throw Error('Image generator unavailable');
            await update('generating-image',10+index*6,`${configuredImageProvider||'Генератор'} створює образ ${index+1} із ${scenes.length}: ${scene.label}.`,true);
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
      }finally{if(jobs.get(release.id)===controller)jobs.delete(release.id);if(dir)await rm(dir,{recursive:true,force:true});}
    })();tasks.add(task);void task.finally(()=>tasks.delete(task));
  }
  app.post('/api/factory/releases',async(req,reply)=>{
    const {requestKey,channelId,ideaId}=z.object({requestKey:uuid,channelId:containerId.default('veil-of-ages'),ideaId:uuid.optional()}).strict().parse(req.body);
    const s=needStorage();if(!options.render)await checkMediaTools();
    const {release,fresh}=await startRelease(s,requestKey,!!imageGenerator,channelId,ideaId);if(fresh)work(release);
    return reply.code(fresh?202:200).send({id:release.id,state:release.state});
  });
  app.post('/api/factory/releases/:id/retry',async(req,reply)=>{
    needStorage();const id=uuid.parse((req.params as {id:string}).id);
    const release=await factoryLock(async db=>{
      if((await db.query("SELECT id FROM factory_releases WHERE state='rendering' OR short_state='rendering'")).rowCount)throw new FactoryError(409,'Лінія зайнята.');
      const r=(await db.query("UPDATE factory_releases SET state='rendering',stage='preparing',progress=2,progress_detail='Готуємо полегшений повтор з одним образом і тими самими матеріалами.',recipe=jsonb_set(recipe,'{productionPlan,sceneCount}','1'::jsonb,true),error=NULL,started_at=NOW(),render_started_at=NULL,processed_seconds=NULL,render_duration=NULL,updated_at=NOW() WHERE id=$1 AND state='failed' RETURNING *",[id])).rows[0];
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
      const result=await app.inject({method:'POST',url:'/youtube/upload?'+new URLSearchParams({title:release.title,children:meta.children,synthetic:meta.synthetic,description:String(release.recipe?.youtubeDescription||'Original music release from Veil of Ages.'),tags:Array.isArray(release.recipe?.youtubeTags)?release.recipe.youtubeTags.join(','):''}),headers:{cookie:req.headers.cookie??'',origin:ownerOrigin(),'content-type':'video/mp4'},payload:file});
      const data=result.json();if(result.statusCode!==200||!data.videoId)throw Error('Upload not confirmed');
      let thumbnailWarning:string|null=null;
      try{await attachYoutubeThumbnail(release,data.videoId,req.headers.cookie??'');}
      catch(error){thumbnailWarning=error instanceof FactoryError?error.message:'Відео завантажено приватно, але YouTube не підтвердив власну обкладинку.';}
      await requirePool().query("UPDATE factory_releases SET state='private',video_id=$2,error=$3,updated_at=NOW() WHERE id=$1",[id,data.videoId,thumbnailWarning]);return {videoId:data.videoId,thumbnailSet:!thumbnailWarning,warning:thumbnailWarning};
    }catch{
      await requirePool().query("UPDATE factory_releases SET state='uncertain',error='Передачу не підтверджено. Перевір YouTube Studio; автоматичний повтор заблоковано.',updated_at=NOW() WHERE id=$1",[id]);
      return reply.code(502).send({error:'Перевір YouTube Studio перед повторними діями. Результат передачі невідомий.'});
    }
  });
  app.post('/api/factory/releases/:id/publish-short',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const meta=z.object({children:z.enum(['yes','no']),synthetic:z.enum(['yes','no']),rights:z.literal(true)}).strict().parse(req.body);
    const release=(await requirePool().query("UPDATE factory_releases SET short_publish_state='publishing',short_publish_error=NULL,updated_at=NOW() WHERE id=$1 AND state IN ('review','private') AND short_state='review' AND short_output_id IS NOT NULL AND short_publish_state IS NULL RETURNING *",[id])).rows[0];
    if(!release)throw new FactoryError(409,'Shorts не готовий або вже передавався. Не повторюй невідоме завантаження без перевірки YouTube.');
    try{
      const asset=(await requirePool().query("SELECT * FROM factory_assets WHERE id=$1 AND kind='video' AND state='ready'",[release.short_output_id])).rows[0];
      if(!asset)throw Error('Shorts asset not ready');
      const file=await needStorage().get(asset.object_key,MAX_OUTPUT_BYTES);
      const tags=Array.isArray(release.recipe?.youtubeTags)?[...release.recipe.youtubeTags,'Shorts'].join(','):'Viking music,Veil of Ages,Shorts';
      const description=String(release.recipe?.youtubeDescription||'Original Viking song from Veil of Ages.')+'\n\nListen to the full song on Veil of Ages. #Shorts';
      const title=(release.title+' | Viking Song #Shorts').slice(0,100);
      const result=await app.inject({method:'POST',url:'/youtube/upload?'+new URLSearchParams({title,children:meta.children,synthetic:meta.synthetic,description,tags}),headers:{cookie:req.headers.cookie??'',origin:ownerOrigin(),'content-type':'video/mp4'},payload:file});
      const data=result.json();if(result.statusCode!==200||!data.videoId)throw Error('Shorts upload not confirmed');
      await requirePool().query("UPDATE factory_releases SET short_publish_state='private',short_video_id=$2,short_publish_error=NULL,updated_at=NOW() WHERE id=$1",[id,data.videoId]);
      return {videoId:data.videoId};
    }catch{
      await requirePool().query("UPDATE factory_releases SET short_publish_state='uncertain',short_publish_error='Передачу Shorts не підтверджено. Перевір YouTube Studio; автоматичний повтор заблоковано.',updated_at=NOW() WHERE id=$1",[id]);
      return reply.code(502).send({error:'Перевір YouTube Studio: результат передачі Shorts невідомий.'});
    }
  });
}
