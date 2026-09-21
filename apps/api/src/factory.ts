import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { requirePool } from './db.js';
import { ownerOrigin } from './owner-auth.js';
import { mediaKind, videoKind, renderMedia, renderVideoClips, runMediaTool, checkMediaTools, analyzeShortsRhythm, MAX_OUTPUT_BYTES, MediaToolError } from './media-render.js';
import { createObjectStore, STORAGE_LIMIT, INPUT_LIMIT, type ObjectStore } from './factory-storage.js';
import { FactoryError, reserveAsset, startRelease, factoryLock, capacity } from './factory-store.js';
import { factoryPage, factoryCss, factoryScript } from './factory-ui.js';
import { factoryFavicon } from './factory-favicon.js';
import { factoryChannelCss } from './factory-channel-ui.js';
import { createShortsStoryPlan, createPreferredImageGenerator, imageGeneratorProvider, createOpenAIShortsClipOrderer, SHORTS_SCENE_COUNT, type ImageGenerator, type ShortsClipOrderer } from './factory-ai.js';
import { ACTIVE_EFFECT_IDS, EFFECT_CATALOG, motionIntensitySchema } from './factory-effects.js';
import { approveSongIdea, createSongIdea, textGeneratorConfigured, textGeneratorProvider } from './factory-song.js';
import { songMode, songPackageSchema } from './factory-song-domain.js';
import { buildShortsArtwork, buildShortsLyricTrack, buildYoutubeThumbnail } from './factory-thumbnail.js';
import { alignShortsWordsToRhythm, buildManualShortsLyrics, shortsTranscriptionConfigured, transcribeShortsLyrics, type ShortsLyricSelection } from './shorts-lyrics.js';
import { waitForMemory } from './memory-budget.js';
import { uploadPrivateVideoFile, YoutubeUploadOutcomeError, type Metadata as YoutubeMetadata } from './youtube-upload.js';
import { getLocalWorkerSummary, localWorkerConfigured } from './local-worker-api.js';
import { config } from './config.js';

const uuid=z.string().uuid();
const vocal=z.enum(['instrumental','choir']);
const containerId=z.string().regex(/^[a-z0-9-]{2,40}$/);
const UPLOAD_MAX=25*1024*1024;
const SHORTS_MAX_BYTES=16*1024*1024;
export async function factoryRoutes(app: FastifyInstance, options: { storage?: ObjectStore; render?: typeof renderMedia; renderClips?: typeof renderVideoClips; probe?: (file: string, kind: string) => Promise<number>; imageGenerator?: ImageGenerator|null; lyricTranscriber?:((file:string,knownLyrics:string,duration:number,signal?:AbortSignal)=>Promise<ShortsLyricSelection|null>)|null; rhythmAnalyzer?:typeof analyzeShortsRhythm|null; clipOrderer?:ShortsClipOrderer|null; clipFrameExtractor?:(file:string,duration:number,signal?:AbortSignal)=>Promise<Buffer>; publisher?:(path:string,metadata:YoutubeMetadata)=>Promise<{videoId:string;duplicate:boolean}> } = {}) {
  const storage=options.storage ?? createObjectStore();
  const imageGenerator=options.imageGenerator===undefined?createPreferredImageGenerator():options.imageGenerator;
  const configuredImageProvider=options.imageGenerator===undefined?imageGeneratorProvider():options.imageGenerator?'Генератор образів':null;
  const lyricTranscriber=options.lyricTranscriber===undefined?(shortsTranscriptionConfigured()?transcribeShortsLyrics:null):options.lyricTranscriber;
  const rhythmAnalyzer=options.rhythmAnalyzer===undefined?(options.render?null:analyzeShortsRhythm):options.rhythmAnalyzer;
  const clipOrderer=options.clipOrderer===undefined?createOpenAIShortsClipOrderer():options.clipOrderer;
  const extractClipFrame=options.clipFrameExtractor??(async(file,duration,signal)=>{const frame=file+'.jpg';await runMediaTool(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-ss',Math.min(4,Math.max(.1,duration/2)).toFixed(3),'-i',file,'-frames:v','1','-vf','scale=320:-2','-q:v','5',frame],45000,signal);return readFile(frame);});
  const publishVideo=options.publisher??uploadPrivateVideoFile;
  const tasks=new Set<Promise<void>>();const jobs=new Map<string,AbortController>();let uploading=false;
  // This lock protects the single heavy FFmpeg/AI lane. Keep enough metadata to
  // recover after a cancelled task or a worker that disappeared without running
  // its finally block (for example, a Render restart during an image request).
  let heavyOperation:{token:symbol;label:string;startedAt:number;releaseId?:string}|null=null;
  const beginHeavy=(label:string)=>{
    if(heavyOperation)throw new FactoryError(409,`Зараз виконується важка операція «${heavyOperation.label}». Вона збереже свій етап, після чого можна продовжити.`);
    const token=Symbol(label);heavyOperation={token,label,startedAt:Date.now()};return token;
  };
  const bindHeavyRelease=(token:symbol,releaseId:string)=>{if(heavyOperation?.token===token)heavyOperation.releaseId=releaseId;};
  const endHeavy=(token:symbol)=>{if(heavyOperation?.token===token)heavyOperation=null;};
  const recoverHeavy=async()=>{
    const operation=heavyOperation;
    if(!operation)return;
    try{
      if(operation.releaseId){
        const row=(await requirePool().query('SELECT state,short_state,short_publish_state FROM factory_releases WHERE id=$1',[operation.releaseId])).rows[0];
        const active=!!row&&(['rendering','publishing'].includes(String(row.state))||row.short_state==='rendering'||['publishing','uncertain'].includes(String(row.short_publish_state)));
        // A cancel request may have committed while the old task was still
        // unwinding. Do not let that old in-memory lock block the next run.
        if(!active){jobs.get(operation.releaseId)?.abort();endHeavy(operation.token);return;}
        // Rendering jobs are always registered in `jobs`. If the database still
        // says rendering but the process has already lost that job, recover the
        // row instead of making every following request wait for a phantom task.
        const isRender=operation.label.includes('монтаж')||operation.label.includes('підготовка');
        if(isRender&&!jobs.has(operation.releaseId)){
          if(operation.label.includes('Shorts'))await requirePool().query("UPDATE factory_releases SET short_state='failed',short_stage='interrupted',short_progress_detail='Фоновий процес зник до завершення.',short_error='Процес Shorts перервано. Матеріали збережено — можна повторити.',short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[operation.releaseId]);
          else await requirePool().query("UPDATE factory_releases SET state='failed',stage='interrupted',progress_detail='Процес монтажу перервано. Матеріали збережено — можна повторити.',error='Монтаж перервано. Можна безпечно повторити.',updated_at=NOW() WHERE id=$1 AND state='rendering'",[operation.releaseId]);
          endHeavy(operation.token);return;
        }
      }else if(!tasks.size){
        // The request failed before it could start its background task.
        endHeavy(operation.token);return;
      }
      // A valid render can be long, but it must never hold the lane forever.
      // This matches the database stale-progress recovery window below.
      if(Date.now()-operation.startedAt<30*60*1000)return;
      const id=operation.releaseId;
      if(id){
        jobs.get(id)?.abort();
        if(operation.label.includes('Shorts'))await requirePool().query("UPDATE factory_releases SET short_state='failed',short_stage='interrupted',short_progress_detail='Не отримували оновлень понад 30 хвилин.',short_error='Процес Shorts не передавав прогрес понад 30 хвилин. Матеріали збережено — можна повторити.',short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[id]);
        else if(operation.label.includes('монтаж')||operation.label.includes('відео'))await requirePool().query("UPDATE factory_releases SET state='failed',stage='interrupted',progress_detail='Монтаж не передавав прогрес понад 30 хвилин. Матеріали збережено — можна повторити.',error='Монтаж зупинено після тривалої відсутності прогресу.',updated_at=NOW() WHERE id=$1 AND state='rendering'",[id]);
      }
      endHeavy(operation.token);
    }catch{ /* keep the lock when the database is temporarily unavailable */ }
  };
  const beginHeavyAfterCleanup=async(label:string)=>{
    await recoverHeavy();
    const deadline=Date.now()+15000;
    while(heavyOperation&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    await recoverHeavy();
    return beginHeavy(label);
  };
  const storageToFile=async(s:ObjectStore,key:string,path:string,max:number)=>s.getFile?s.getFile(key,path,max):s.get(key,max).then(data=>writeFile(path,data).then(()=>data.length));
  const fileToStorage=async(s:ObjectStore,key:string,path:string,type:string)=>s.putFile?s.putFile(key,path,type):(async()=>{const data=await readFile(path);await s.put(key,data,type);return data.length;})();
  const needStorage=()=>{if(!storage)throw new FactoryError(503,`Підключи приватне сховище R2 у ${config.VEIL_LOCAL_MODE?'.env.local':'Render'}. Файли ще не завантажуються.`);return storage;};
  const reserveShortStory=async(db:PoolClient,current:Record<string,any>,regenerate=false)=>{
    const currentSceneCount=Array.isArray(current.short_plan?.scenes)?current.short_plan.scenes.length:0;
    if(current.short_plan&&!regenerate&&currentSceneCount===SHORTS_SCENE_COUNT)return current;
    let storyRecipe=current.recipe||{};
    const ideaId=String(storyRecipe.ideaId||'');
    if(ideaId){const idea=(await db.query('SELECT content FROM factory_song_ideas WHERE id=$1',[ideaId])).rows[0];if(idea?.content?.lyrics)storyRecipe={...storyRecipe,lyrics:String(idea.content.lyrics).slice(0,7000),storyConcept:String(idea.content.concept||storyRecipe.storyConcept||'')};}
    const plan=await createShortsStoryPlan(randomUUID(),current.title,storyRecipe);
    return (await db.query('UPDATE factory_releases SET short_plan=$2,short_error=NULL,short_updated_at=NOW() WHERE id=$1 RETURNING *',[current.id,JSON.stringify(plan)])).rows[0];
  };
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin')
      .header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(!req.ownerSession?.verified)return reply.code(401).send({error:'Увійди в кабінет і підтвердь Authenticator.'});
    if(req.method==='POST'&&req.headers.origin!==ownerOrigin())return reply.code(403).send({error:'Відкрий фабрику зі свого кабінету.'});
  });
  app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof FactoryError?e.status:e instanceof z.ZodError?400:503).send({error:e instanceof FactoryError?e.message:e instanceof z.ZodError?'Перевір заповнені поля.':'Операцію не підтверджено. Онови стан перед повтором. Перевір підключення R2 та бази.'}));
  await app.register(multipart,{limits:{files:1,fields:0,parts:1,fileSize:UPLOAD_MAX}});
  app.addHook('onClose',async()=>{for(const controller of jobs.values())controller.abort();await Promise.allSettled([...tasks]);});
  app.get('/factory',async(_req,reply)=>reply.type('text/html').send(factoryPage.replace('</title>','</title><link rel="icon" href="/factory/icon.svg" type="image/svg+xml">')));
  app.get('/factory/icon.svg',async(_req,reply)=>reply.type('image/svg+xml').send(factoryFavicon));
  app.get('/factory/style.css',async(_req,reply)=>reply.type('text/css').send(factoryCss+factoryChannelCss));
  app.get('/factory/app.js',async(_req,reply)=>reply.type('application/javascript').send(factoryScript));
  app.get('/api/factory',async()=>{
    // No silent restart of expensive work. A retry explicitly keeps the same track and cover.
    const orphanedShorts=(await requirePool().query("SELECT id FROM factory_releases WHERE short_state='rendering'")).rows.filter(row=>!jobs.has(String(row.id)));
    for(const row of orphanedShorts)await requirePool().query("UPDATE factory_releases SET short_state='failed',short_stage='interrupted',short_progress_detail='Сервер перезапустився, а старого процесу FFmpeg вже немає.',short_error='Попередній процес Shorts більше не працює. Матеріали збережено — можна одразу повторити.',short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[row.id]);
    await requirePool().query("UPDATE factory_releases SET state='failed',stage='interrupted',error='Сервер перестав передавати прогрес. Можна повторити складання з тими самими матеріалами.',updated_at=NOW() WHERE state='rendering' AND stage<>'waiting-local' AND stage NOT LIKE 'local-%' AND updated_at<NOW()-INTERVAL '30 minutes'");
    await requirePool().query("UPDATE factory_releases SET state='uncertain',error='Передачу перервано. Перевір YouTube Studio перед повторними діями.',updated_at=NOW() WHERE state='publishing' AND updated_at<NOW()-INTERVAL '10 minutes'");
    await requirePool().query("UPDATE factory_releases SET short_publish_state='uncertain',short_publish_error='Передачу Shorts перервано. Перевір YouTube Studio перед повторними діями.',updated_at=NOW() WHERE short_publish_state='publishing' AND updated_at<NOW()-INTERVAL '10 minutes'");
    await requirePool().query("UPDATE factory_releases SET short_state='failed',short_stage='interrupted',short_progress_detail='Сервер перестав передавати оновлення.',short_error='Створення Shorts перервав перезапуск сервера. Можна безпечно повторити.',short_updated_at=NOW() WHERE short_state='rendering' AND short_updated_at<NOW()-INTERVAL '30 minutes'");
    await requirePool().query("UPDATE factory_song_ideas SET state='failed',error='Генерацію перервав перезапуск сервера. Запусти створення тексту ще раз.',updated_at=NOW() WHERE state='generating' AND updated_at<NOW()-INTERVAL '3 minutes'");
    const db=requirePool();
    const [recipe,assets,releases,counts,channels,containers,channelContainers,ideas,notes,shortClips]=await Promise.all([
      db.query('SELECT * FROM factory_recipe WHERE id=1'),
      db.query(`SELECT a.*,c.name AS container_name FROM factory_assets a LEFT JOIN factory_containers c ON c.id=a.container_id ORDER BY a.created_at DESC LIMIT 300`),
      db.query('SELECT * FROM factory_releases ORDER BY created_at DESC LIMIT 100'),
      db.query(`SELECT cc.channel_id,a.vocal,COUNT(*) AS available FROM factory_assets a JOIN factory_channel_containers cc ON cc.container_id=a.container_id WHERE a.kind='audio' AND a.state='ready' AND NOT EXISTS(SELECT 1 FROM factory_releases r WHERE r.track_id=a.id) GROUP BY cc.channel_id,a.vocal`),
      db.query('SELECT * FROM factory_channels WHERE active=TRUE ORDER BY created_at,id'),
      db.query('SELECT * FROM factory_containers ORDER BY position,name'),
      db.query('SELECT channel_id,container_id FROM factory_channel_containers ORDER BY channel_id,container_id'),
      db.query('SELECT * FROM factory_song_ideas WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT 20'),
      db.query('SELECT * FROM factory_notes ORDER BY completed ASC, updated_at DESC, created_at DESC LIMIT 200'),
      db.query(`SELECT c.release_id,c.position,c.asset_id,a.name,a.bytes,a.type,a.duration
        FROM factory_short_clips c JOIN factory_assets a ON a.id=c.asset_id ORDER BY c.release_id,c.position`)
    ]);
    const availableByChannel:Record<string,Record<string,number>>={};for(const r of counts.rows)(availableByChannel[r.channel_id]??={})[r.vocal]=Number(r.available);
    return {configured:!!storage,localMode:config.VEIL_LOCAL_MODE,aiConfigured:!!imageGenerator,imageAiProvider:configuredImageProvider,textAiConfigured:textGeneratorConfigured(),textAiProvider:textGeneratorProvider(),shortsLyricsConfigured:true,shortsClipMatchingConfigured:!!clipOrderer,localWorker:await getLocalWorkerSummary(),recipe:recipe.rows[0],effects:EFFECT_CATALOG,assets:assets.rows,releases:releases.rows,ideas:ideas.rows,notes:notes.rows,shortClips:shortClips.rows,channels:channels.rows,containers:containers.rows,channelContainers:channelContainers.rows,availableByChannel,availableByVocal:Object.fromEntries(counts.rows.filter(r=>r.channel_id==='veil-of-ages').map(r=>[r.vocal,Number(r.available)])),limit:STORAGE_LIMIT,inputLimit:INPUT_LIMIT};
  });
  app.post('/api/factory/notes',async(req,reply)=>{
    const body=z.object({text:z.string().trim().min(1).max(1000)}).strict().parse(req.body);
    const note=(await requirePool().query('INSERT INTO factory_notes(id,text) VALUES($1,$2) RETURNING *',[randomUUID(),body.text])).rows[0];
    return reply.code(201).send(note);
  });
  app.post('/api/factory/notes/:id/toggle',async req=>{
    const id=uuid.parse((req.params as {id:string}).id),body=z.object({completed:z.boolean()}).strict().parse(req.body);
    const note=(await requirePool().query('UPDATE factory_notes SET completed=$2,updated_at=NOW() WHERE id=$1 RETURNING *',[id,body.completed])).rows[0];
    if(!note)throw new FactoryError(404,'Нотатку не знайдено. Онови список.');
    return note;
  });
  app.post('/api/factory/notes/:id/delete',async req=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const note=(await requirePool().query('DELETE FROM factory_notes WHERE id=$1 RETURNING id',[id])).rows[0];
    if(!note)throw new FactoryError(404,'Нотатку вже видалено.');
    return {deleted:true};
  });
  app.post('/api/factory/ideas',{bodyLimit:5000,logLevel:'silent'},async req=>{
    const body=z.object({channelId:containerId.default('veil-of-ages'),mode:songMode,brief:z.string().trim().max(3000).default('')}).strict().parse(req.body);
    return createSongIdea(body.channelId,body.mode,body.brief,AbortSignal.timeout(90000));
  });
  app.post('/api/factory/ideas/:id/approve',async req=>approveSongIdea(uuid.parse((req.params as {id:string}).id)));
  app.post('/api/factory/ideas/:id/dismiss',async req=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const idea=(await requirePool().query("UPDATE factory_song_ideas SET dismissed_at=NOW(),updated_at=NOW() WHERE id=$1 AND state<>'generating' AND dismissed_at IS NULL RETURNING id",[id])).rows[0];
    if(!idea)throw new FactoryError(409,'Цей задум зараз не можна відкласти. Онови сторінку.');
    return {dismissed:true};
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
    const body=z.object({vocal,motionIntensity:motionIntensitySchema,coverId:uuid.nullable(),containerIds:z.array(containerId).min(1).max(12).optional(),revision:z.number().int().positive()}).strict().parse(req.body);
    if(body.coverId&&!(await requirePool().query("SELECT id FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[body.coverId])).rowCount)throw new FactoryError(400,'Обкладинка ще не збережена.');
    return factoryLock(async db=>{const current=(await db.query('SELECT * FROM factory_recipe WHERE id=1 FOR UPDATE')).rows[0];if(!current||current.revision!==body.revision)throw new FactoryError(409,'Рецепт змінився в іншій вкладці. Онови сторінку.');if(body.containerIds){const valid=await db.query('SELECT id FROM factory_containers WHERE id=ANY($1::text[])',[body.containerIds]);if(valid.rows.length!==new Set(body.containerIds).size)throw new FactoryError(400,'Один із жанрових контейнерів не існує.');await db.query('DELETE FROM factory_channel_containers WHERE channel_id=$1',[current.channel_id]);for(const id of new Set(body.containerIds))await db.query('INSERT INTO factory_channel_containers(channel_id,container_id) VALUES($1,$2)',[current.channel_id,id]);}return (await db.query("UPDATE factory_recipe SET vocal=$1,cover_id=$2,visual_preset='auto',motion_intensity=$3,revision=revision+1 WHERE id=1 RETURNING *",[body.vocal,body.coverId,body.motionIntensity])).rows[0];});
  });
  app.post('/api/factory/assets',{logLevel:'silent'},async(req,reply)=>{
    const s=needStorage();if(uploading)throw new FactoryError(429,'Дочекайся завершення поточного файла.');uploading=true;
    let dir:string|undefined;
    try{
      const requested=z.object({kind:z.enum(['audio','image','video']),vocal:vocal.default('instrumental'),containerId:containerId.default('viking-anthem'),theme:z.string().trim().max(2000).default(''),ideaId:uuid.optional()}).parse(req.query);
      let meta:{kind:'audio'|'image'|'video';vocal:'instrumental'|'choir';containerId:string;theme:string}={...requested,theme:requested.theme.slice(0,500)};
      let idea:{id:string;mode:'viking-anthem'|'viking-rap-duet';content:unknown;audio_id:string|null}|null=null;
      if(requested.ideaId){
        if(requested.kind!=='audio')throw new FactoryError(400,'До задуму можна прикріпити лише готову пісню.');
        idea=(await requirePool().query("SELECT id,mode,content,audio_id FROM factory_song_ideas WHERE id=$1 AND state='approved'",[requested.ideaId])).rows[0]||null;
        if(!idea)throw new FactoryError(409,'Спочатку затвердь назву та слова.');if(idea.audio_id)throw new FactoryError(409,'До цього задуму вже додано готову пісню.');
        const content=songPackageSchema.parse(idea.content);meta={kind:'audio',vocal:'choir',containerId:idea.mode,theme:content.concept.slice(0,500)};
      }
      const part=await req.file();if(!part)throw new FactoryError(400,'Обери файл.');
      const data=await part.toBuffer();if(part.file.truncated||data.length>UPLOAD_MAX||data.length<16)throw new FactoryError(400,'Файл має бути до 25 МіБ.');
      let kind:string;
      try{kind=meta.kind==='video'?videoKind(data.subarray(0,16)):mediaKind(data.subarray(0,16),meta.kind==='image');}
      catch(e){throw new FactoryError(400,e instanceof Error?e.message:'Формат файла не підтримується.');}
      if(meta.kind==='image'&&data.length>8*1024*1024)throw new FactoryError(400,'Обкладинка має бути до 8 МіБ.');
      let duration:number|null=null;
      if(meta.kind==='audio'||meta.kind==='video'){
        dir=await mkdtemp(join(tmpdir(),'veil-probe-'));const file=join(dir,meta.kind+'.'+kind);await writeFile(file,data);
        if(options.probe)duration=await options.probe(file,kind);
        else {const forcedFormat=meta.kind==='video'?[]:['-f',kind],result=JSON.parse(await runMediaTool(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-max_alloc','67108864','-protocol_whitelist','file,pipe',...forcedFormat,'-show_entries','format=duration:stream=codec_type','-of','json',file],15000));duration=Number(result.format?.duration);if(!result.streams?.some((v:{codec_type:string})=>v.codec_type===meta.kind))duration=0;}
        if(!Number.isFinite(duration)||duration!<1||duration!>300)throw new FactoryError(400,meta.kind==='audio'?'Перший сценарій приймає треки від 1 секунди до 5 хвилин. Довгі ambient-збірки додамо окремо.':'Відеофрагмент має тривати від 1 секунди до 5 хвилин. Для Shorts найкраще 3–12 секунд.');
      }
      if(meta.kind==='audio'&&!(await requirePool().query('SELECT id FROM factory_containers WHERE id=$1',[meta.containerId])).rowCount)throw new FactoryError(400,'Обраний жанровий контейнер не існує.');
      const type=meta.kind==='audio'?(kind==='mp3'?'audio/mpeg':'audio/wav'):meta.kind==='image'?(kind==='png'?'image/png':'image/jpeg'):(kind==='webm'?'video/webm':'video/mp4');
      const originalName=part.filename.replace(/[<>\x00-\x1f]/g,'').slice(0,150)||'Без назви';
      const content=idea?songPackageSchema.parse(idea.content):null;
      const savedName=content?content.title.replace(/[<>\x00-\x1f]/g,'').slice(0,135)+(kind==='mp3'?'.mp3':'.wav'):originalName;
      const {asset,fresh}=await reserveAsset(s,{...meta,hash:createHash('sha256').update(data).digest('hex'),name:savedName,bytes:data.length,type,duration});
      if(!fresh){
        if(idea){
          if((await requirePool().query('SELECT id FROM factory_song_ideas WHERE audio_id=$1 AND id<>$2',[asset.id,idea.id])).rowCount)throw new FactoryError(409,'Цей аудіофайл уже належить іншому задуму. Відклади цей задум і почни нову пісню.');
          const existingRelease=(await requirePool().query('SELECT id,title,recipe FROM factory_releases WHERE track_id=$1',[asset.id])).rows[0];
          if(existingRelease){
            const song=songPackageSchema.parse(idea.content),releaseIdea=existingRelease.recipe?.ideaId;
            if(releaseIdea===idea.id||(!releaseIdea&&existingRelease.title===song.title)){
              await factoryLock(async db=>{
                await db.query('UPDATE factory_song_ideas SET audio_id=$2,updated_at=NOW() WHERE id=$1',[idea.id,asset.id]);
                await db.query("UPDATE factory_releases SET recipe=jsonb_set(recipe,'{ideaId}',to_jsonb($2::text),true),updated_at=NOW() WHERE id=$1 AND recipe->>'ideaId' IS NULL",[existingRelease.id,idea.id]);
              });
              return {id:asset.id,duplicate:true,alreadyReleased:true,releaseId:existingRelease.id,ideaId:idea.id};
            }
            throw new FactoryError(409,'Цей аудіофайл уже належить іншому відео. Відклади цей задум і почни нову пісню.');
          }
        }
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
    const range=String(req.headers.range||''),match=/^bytes=(\d*)-(\d*)$/.exec(range);reply.header('Accept-Ranges','bytes').header('Content-Disposition','inline');
    if(match){const total=data.length,suffix=match[1]==='',requestedStart=suffix?Math.max(0,total-Number(match[2]||0)):Number(match[1]),requestedEnd=suffix?total-1:match[2]?Number(match[2]):total-1,start=Math.max(0,Math.min(total-1,requestedStart)),end=Math.max(start,Math.min(total-1,requestedEnd));if(!Number.isFinite(start)||!Number.isFinite(end)||requestedStart>=total)return reply.code(416).header('Content-Range',`bytes */${total}`).send();const chunk=data.subarray(start,end+1);return reply.code(206).type(a.type).header('Content-Range',`bytes ${start}-${end}/${total}`).header('Content-Length',String(chunk.length)).send(chunk);}
    return reply.type(a.type).header('Content-Length',String(data.length)).send(data);
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
    const id=uuid.parse((req.params as {id:string}).id),release=(await requirePool().query('SELECT id,title,cover_id,short_cover_id,short_plan FROM factory_releases WHERE id=$1',[id])).rows[0];
    if(!release)throw new FactoryError(404,'Випуск не знайдено.');
    const cover=(await requirePool().query("SELECT object_key FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[release.short_cover_id||release.cover_id])).rows[0];
    if(!cover)throw new FactoryError(409,'Обкладинка ще створюється.');
    const source=await needStorage().get(cover.object_key,8*1024*1024),poster=await buildShortsArtwork(source,release.title);
    return reply.type('image/jpeg').header('Content-Disposition','inline').send(poster);
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
  const attachShortsYoutubeThumbnail=async(release:{id:string;title:string;cover_id:string},videoId:string,cookie:string)=>{
    const cover=(await requirePool().query("SELECT object_key FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[release.cover_id])).rows[0];
    if(!cover)throw new FactoryError(409,'Обкладинка Shorts не знайдена.');
    const source=await needStorage().get(cover.object_key,8*1024*1024),thumbnail=await buildShortsArtwork(source,release.title);
    const result=await app.inject({method:'POST',url:'/youtube/thumbnail?'+new URLSearchParams({videoId}),headers:{cookie,origin:ownerOrigin(),'content-type':'image/jpeg'},payload:thumbnail});
    const data=result.json() as {error?:string};
    if(result.statusCode!==200)throw new FactoryError(result.statusCode===502?502:409,data.error||'YouTube не підтвердив вертикальну обкладинку Shorts.');
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
  app.post('/api/factory/releases/:id/shorts-thumbnail',{logLevel:'silent'},async(req)=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const release=(await requirePool().query("SELECT id,title,cover_id,short_cover_id,short_video_id,short_publish_state FROM factory_releases WHERE id=$1",[id])).rows[0];
    if(!release)throw new FactoryError(404,'Випуск не знайдено.');
    if(release.short_publish_state!=='private'||!release.short_video_id)throw new FactoryError(409,'Спочатку Shorts має бути приватно завантажений на YouTube.');
    const thumbnailRelease={id:release.id,title:release.title,cover_id:release.short_cover_id||release.cover_id};
    try{await attachShortsYoutubeThumbnail(thumbnailRelease,release.short_video_id,req.headers.cookie??'');}
    catch(error){const message=error instanceof FactoryError?error.message:'YouTube не підтвердив обкладинку Shorts.';await requirePool().query('UPDATE factory_releases SET short_publish_error=$2,updated_at=NOW() WHERE id=$1',[id,message]);throw error;}
    await requirePool().query('UPDATE factory_releases SET short_publish_error=NULL,updated_at=NOW() WHERE id=$1',[id]);
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
      if((await db.query('SELECT id FROM factory_releases WHERE track_id=$1 OR cover_id=$1 OR output_id=$1 OR short_output_id=$1 OR short_cover_id=$1 LIMIT 1',[id])).rowCount||(await db.query('SELECT release_id FROM factory_release_scenes WHERE asset_id=$1 LIMIT 1',[id])).rowCount)throw new FactoryError(409,'Матеріал використовується у випуску. Спочатку видали відповідний випуск.');
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
      const shortCover=release.short_cover_id?(await db.query('SELECT * FROM factory_assets WHERE id=$1',[release.short_cover_id])).rows[0]:null;
      const extraShortScenes=(await db.query('SELECT a.* FROM factory_short_scenes s JOIN factory_assets a ON a.id=s.asset_id WHERE s.release_id=$1 ORDER BY s.position',[id])).rows.filter(asset=>asset.id!==shortCover?.id);
      const shortClipCandidates=(await db.query('SELECT DISTINCT a.* FROM factory_short_clips c JOIN factory_assets a ON a.id=c.asset_id WHERE c.release_id=$1',[id])).rows;
      const removableShortClips=[];
      for(const clip of shortClipCandidates){const usedElsewhere=!!(await db.query('SELECT release_id FROM factory_short_clips WHERE asset_id=$1 AND release_id<>$2 LIMIT 1',[clip.id,id])).rowCount;if(!usedElsewhere)removableShortClips.push(clip);}
      const generated=release.recipe?.coverMode==='ai';
      let scenes=generated?(await db.query('SELECT a.* FROM factory_release_scenes s JOIN factory_assets a ON a.id=s.asset_id WHERE s.release_id=$1 ORDER BY s.position',[id])).rows:[];
      if(generated&&!scenes.length){const legacyCover=(await db.query('SELECT * FROM factory_assets WHERE id=$1',[release.cover_id])).rows[0];if(legacyCover)scenes=[legacyCover];}
      const removableScenes=[];
      for(const scene of scenes){const inRecipe=!!(await db.query('SELECT id FROM factory_recipe WHERE cover_id=$1',[scene.id])).rowCount;if(!inRecipe)removableScenes.push(scene);}
      if(output)await deleteStored(s,output);if(shortOutput)await deleteStored(s,shortOutput);if(shortCover)await deleteStored(s,shortCover);for(const scene of extraShortScenes)await deleteStored(s,scene);for(const clip of removableShortClips)await deleteStored(s,clip);for(const scene of removableScenes)await deleteStored(s,scene);
      await db.query('DELETE FROM factory_releases WHERE id=$1',[id]);
      if(output)await db.query('DELETE FROM factory_assets WHERE id=$1',[output.id]);
      if(shortOutput)await db.query('DELETE FROM factory_assets WHERE id=$1',[shortOutput.id]);
      if(shortCover)await db.query('DELETE FROM factory_assets WHERE id=$1',[shortCover.id]);
      for(const scene of extraShortScenes)await db.query('DELETE FROM factory_assets WHERE id=$1',[scene.id]);
      for(const clip of removableShortClips)await db.query('DELETE FROM factory_assets WHERE id=$1',[clip.id]);
      for(const scene of removableScenes)await db.query('DELETE FROM factory_assets WHERE id=$1',[scene.id]);
      return {deleted:true,freed:Number(output?.bytes||0)+Number(shortOutput?.bytes||0)+Number(shortCover?.bytes||0)+extraShortScenes.reduce((sum,scene)=>sum+Number(scene.bytes||0),0)+removableShortClips.reduce((sum,clip)=>sum+Number(clip.bytes||0),0)+removableScenes.reduce((sum,scene)=>sum+Number(scene.bytes||0),0),keptTrackId:release.track_id};
    });
  });
  async function manualShortsSelection(db:PoolClient,release:Record<string,any>,chorusStart:number){
    const ideaId=String(release.recipe?.ideaId||''),idea=ideaId?(await db.query('SELECT content FROM factory_song_ideas WHERE id=$1',[ideaId])).rows[0]:null;
    const lyrics=String(idea?.content?.lyrics||''),track=(await db.query("SELECT duration FROM factory_assets WHERE id=$1 AND kind='audio' AND state='ready'",[release.track_id])).rows[0];
    if(lyrics.replace(/\s+/g,' ').length<80)throw new FactoryError(409,'У випуску немає збережених слів пісні. Shorts без правильного тексту не створюємо.');
    const selection=buildManualShortsLyrics(lyrics,Number(track?.duration)||0,chorusStart);
    if(!selection)throw new FactoryError(409,'У збереженому тексті не знайдено секцію [Chorus] щонайменше з двома рядками. Додай позначений приспів до слів пісні.');
    return selection;
  }
  function workShort(release:Record<string,any>,heavyToken:symbol){
    bindHeavyRelease(heavyToken,release.id);
    const controller=new AbortController();jobs.set(release.id,controller);
    const task=(async()=>{
      let dir:string|undefined,stage='preparing',progress=Number(release.short_progress)||1,lastStage='',lastProgress=-1,lastWrite=0;
      let writes=Promise.resolve();
      const update=(nextStage:string,nextProgress:number,detail:string,force=false,media?:{seconds:number;duration:number})=>{
        stage=nextStage;progress=Math.max(progress,Math.min(99,Math.round(nextProgress)));
        const now=Date.now();
        if(!force&&nextStage===lastStage&&progress<=lastProgress&&now-lastWrite<2000)return writes;
        if(!force&&nextStage===lastStage&&progress-lastProgress<1&&now-lastWrite<2000)return writes;
        lastStage=nextStage;lastProgress=progress;lastWrite=now;
        writes=writes.then(async()=>{await requirePool().query("UPDATE factory_releases SET short_stage=$2,short_progress=$3,short_progress_detail=$4,short_processed_seconds=COALESCE($5,short_processed_seconds),short_render_duration=COALESCE($6,short_render_duration),short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id,nextStage,progress,detail,media?.seconds??null,media?.duration??null]);}).catch(()=>{});
        return writes;
      };
      const failure=(error:unknown)=>{
        if(stage==='waiting-memory')return 'Монтаж чекав на звільнення пам’яті й був перерваний. Матеріали збережено — можна повторити.';
        if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='stalled')return 'FFmpeg не передавав прогрес понад 5 хвилин, тому завислий монтаж зупинено. Матеріали збережено — можна повторити.';
        if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='timeout')return 'Монтаж Shorts не вклався у 90 хвилин. Матеріали збережено — можна повторити.';
        if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='spawn')return `FFmpeg не запустився. Перевір інструменти ${config.VEIL_LOCAL_MODE?'на цьому ПК':'Render'} перед повтором.`;
        const detail=error instanceof Error?error.message:'';
        return /слів|субтитр|синхрон|OpenAI/i.test(detail)?detail:'Не вдалося скласти Shorts. Матеріали збережено — можна повторити.';
      };
      try{
        await update('preparing',2,'Готуємо окреме робоче місце для Shorts.',true);
        const s=needStorage();dir=await mkdtemp(join(tmpdir(),'veil-shorts-'));
        await update('materials',5,'Перевіряємо музику, обкладинку й місце для готового файла.',true);
        const [track,cover,output]=await Promise.all([
          requirePool().query("SELECT * FROM factory_assets WHERE id=$1 AND kind='audio' AND state='ready'",[release.track_id]).then(r=>r.rows[0]),
          requirePool().query("SELECT * FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[release.cover_id]).then(r=>r.rows[0]),
          requirePool().query("SELECT * FROM factory_assets WHERE id=$1",[release.short_output_id]).then(r=>r.rows[0])
        ]);
        if(!track||!cover||!output)throw Error('Missing Shorts material');
        const audio=join(dir,'audio'),video=join(dir,'shorts.mp4');
        await update('downloading-audio',8,'Отримуємо музику з приватного сховища R2.',true);
        await storageToFile(s,track.object_key,audio,UPLOAD_MAX);
        await update('lyrics',11,'Беремо збережений приспів і готуємо точні слова для вибраних 30 секунд.',true);
        let knownLyrics='';const ideaId=String(release.recipe?.ideaId||'');
        if(ideaId){const idea=(await requirePool().query('SELECT content FROM factory_song_ideas WHERE id=$1',[ideaId])).rows[0];knownLyrics=String(idea?.content?.lyrics||'');}
        if(knownLyrics.replace(/\s+/g,' ').length<80)throw new Error('У цього випуску немає збережених слів пісні. Shorts не створено, щоб не випускати ролик без правильних субтитрів.');
        const saved=release.short_plan?.kineticText;
        let selection:ShortsLyricSelection|null=['manual','transcribed'].includes(saved?.mode)&&Array.isArray(saved.cues)&&saved.cues.length>=2
          ?{clipStart:Number(saved.clipStart)||0,clipDuration:Number(saved.clipDuration)||Math.min(30,Number(track.duration)||30),section:saved.section==='chorus'?'chorus':'vocal',cues:saved.cues}
          :null;
        if(!selection){
          if(!lyricTranscriber)throw new Error('Синхронізація слів Shorts недоступна. Підключи OpenAI — ролик без правильних субтитрів не створюємо.');
          await update('lyrics',12,'Зіставляємо слова пісні з вокалом.',true);selection=await lyricTranscriber(audio,knownLyrics,Number(track.duration)||30,controller.signal);
          if(!selection?.cues?.length)throw new Error('Не вдалося точно зіставити збережені слова пісні з вокалом. Shorts без правильних субтитрів не створено.');
        }
        if(saved?.mode==='manual'&&rhythmAnalyzer){
          await update('lyrics',13,'Аналізуємо ритм вибраного приспіву локально — без Whisper і без зміни слів.',true);
          try{const pulses=await rhythmAnalyzer(audio,track.type==='audio/wav'?'wav':'mp3',selection.clipStart,selection.clipDuration,controller.signal);if(pulses.length>=4)selection={...selection,cues:alignShortsWordsToRhythm(selection.cues,pulses,selection.clipDuration)};}
          catch(error){app.log.warn({releaseId:release.id,reason:error instanceof MediaToolError?error.reason:'analysis'},'Shorts rhythm analysis fell back to lyric timing');}
        }
        const lyricCues=selection.cues,sourceClip={start:selection.clipStart,duration:selection.clipDuration};
        await update('subtitles',14,`Створюємо один легкий шар субтитрів: 0 із ${lyricCues.length} слів.`,true);
        const lyricTrack=await buildShortsLyricTrack(dir,lyricCues,selection.clipDuration,(done,total)=>{void update('subtitles',14+done/total*9,`Створюємо один легкий шар субтитрів: ${done} із ${total} слів.`);});
        if(!lyricTrack)throw new Error('Не вдалося підготувати текстовий шар Shorts.');
        const plan={...(release.short_plan||{}),kineticText:{mode:saved?.mode==='manual'?'manual':'transcribed',cues:lyricCues,clipStart:selection.clipStart,clipDuration:selection.clipDuration,section:selection.section}};
        release.short_plan=plan;await requirePool().query('UPDATE factory_releases SET short_plan=$2,short_updated_at=NOW() WHERE id=$1',[release.id,JSON.stringify(plan)]);
        const manualClips=(await requirePool().query(`SELECT c.position,a.object_key,a.state,a.duration
          FROM factory_short_clips c JOIN factory_assets a ON a.id=c.asset_id
          WHERE c.release_id=$1 AND a.kind='video' AND a.state='ready' ORDER BY c.position`,[release.id])).rows;
        if(release.short_plan?.mode==='manual-video'&&manualClips.length>=SHORTS_SCENE_COUNT){
          const clipFiles:string[]=[];
          for(const [index,clip] of manualClips.entries()){await update('clips',23+index,`Отримуємо відеофрагмент ${index+1} із ${manualClips.length} з R2.`,true);const path=join(dir,`manual-${index}.mp4`);await storageToFile(s,clip.object_key,path,UPLOAD_MAX);clipFiles.push(path);}
          await waitForMemory(controller.signal,budget=>{void update('waiting-memory',29,`Безпечна пауза перед FFmpeg: пам’ять зайнята на ${Math.round(budget.ratio*100)}%. Перевіряємо знову кожні кілька секунд.`,true);});
          await requirePool().query("UPDATE factory_releases SET short_render_started_at=NOW(),short_processed_seconds=0,short_render_duration=$2,short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id,sourceClip.duration]);
          await update('rendering',30,'FFmpeg запущено. Збираємо шість сцен, музику й субтитри.',true);
          await (options.renderClips??renderVideoClips)(clipFiles,manualClips.map(clip=>Number(clip.duration)||1),audio,video,track.type==='audio/wav'?'wav':'mp3',controller.signal,p=>{const processed=Math.min(p.duration,p.seconds);void update('rendering',30+p.percent*.60,`FFmpeg змонтував ${processed.toFixed(1)} із ${p.duration.toFixed(1)} секунд.`,false,{seconds:processed,duration:p.duration});},[],sourceClip,lyricTrack);
          await update('verifying',91,'FFmpeg завершив роботу. Перевіряємо тривалість, звук, вертикальний формат і розмір файла.',true);
          const size=(await stat(video)).size;
          await waitForMemory(controller.signal,budget=>{void update('waiting-memory',95,`Готовий Shorts збережено локально. Чекаємо на пам’ять перед передачею в R2 (${Math.round(budget.ratio*100)}%).`,true);});
          await update('uploading',96,'Передаємо готовий Shorts до приватного сховища R2.',true);await fileToStorage(s,output.object_key,video,'video/mp4');
          await writes;await factoryLock(async db=>{await db.query("UPDATE factory_assets SET state='ready',bytes=$2 WHERE id=$1",[output.id,size]);await db.query("UPDATE factory_releases SET short_state='review',short_stage='complete',short_progress=100,short_progress_detail='Shorts готовий до твоєї перевірки.',short_error=NULL,short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id]);});
          return;
        }
        await update('vertical-frame',23,'Отримуємо обкладинку й готуємо вертикальний кадр 9:16.',true);
        const image=join(dir,'shorts-cover.jpg'),artworkData=await s.get(cover.object_key,8*1024*1024);
        await writeFile(image,await buildShortsArtwork(artworkData,release.title));await update('vertical-frame',25,'Вертикальний кадр і субтитри готові.',true);
        await waitForMemory(controller.signal,budget=>{void update('waiting-memory',29,`Безпечна пауза перед FFmpeg: пам’ять зайнята на ${Math.round(budget.ratio*100)}%. Перевіряємо знову кожні кілька секунд.`,true);});
        const shortEffects=ACTIVE_EFFECT_IDS.filter(id=>id!=='story.three-scenes'&&id!=='transition.scene-crossfades');
        await requirePool().query("UPDATE factory_releases SET short_render_started_at=NOW(),short_processed_seconds=0,short_render_duration=$2,short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id,sourceClip.duration]);
        await update('rendering',30,'FFmpeg запущено. Поєднуємо вертикальний кадр, музику, рух та субтитри.',true);
        await (options.render??renderMedia)(image,audio,video,track.type==='audio/wav'?'wav':'mp3',controller.signal,'shorts',release.recipe.visualPreset,p=>{const processed=Math.min(p.duration,p.seconds);void update('rendering',30+p.percent*.60,`FFmpeg змонтував ${processed.toFixed(1)} із ${p.duration.toFixed(1)} секунд.`,false,{seconds:processed,duration:p.duration});},'expressive',shortEffects,[],lyricTrack,sourceClip);
        await update('verifying',91,'FFmpeg завершив роботу. Перевіряємо тривалість, звук, вертикальний формат і розмір файла.',true);
        const size=(await stat(video)).size;if(size>SHORTS_MAX_BYTES)throw Error('Shorts exceeds reservation');
        await waitForMemory(controller.signal,budget=>{void update('waiting-memory',95,`Готовий Shorts збережено локально. Чекаємо на пам’ять перед передачею в R2 (${Math.round(budget.ratio*100)}%).`,true);});
        await update('uploading',96,'Передаємо готовий Shorts до приватного сховища R2.',true);await fileToStorage(s,output.object_key,video,'video/mp4');
        await writes;await factoryLock(async db=>{await db.query("UPDATE factory_assets SET state='ready',bytes=$2 WHERE id=$1",[output.id,size]);await db.query("UPDATE factory_releases SET short_state='review',short_stage='complete',short_progress=100,short_progress_detail='Shorts готовий до твоєї перевірки.',short_error=NULL,short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id]);});
      }catch(error){await writes;app.log.error({releaseId:release.id,stage,reason:error instanceof MediaToolError?error.reason:'operation'},'Factory Shorts failed');await requirePool().query("UPDATE factory_releases SET short_state='failed',short_stage=$2,short_progress_detail='Зупинено на цьому етапі.',short_error=$3,short_updated_at=NOW() WHERE id=$1 AND short_state='rendering'",[release.id,stage,failure(error)]).catch(()=>{});}
      finally{if(jobs.get(release.id)===controller)jobs.delete(release.id);if(dir)await rm(dir,{recursive:true,force:true});endHeavy(heavyToken);}
    })();tasks.add(task);void task.finally(()=>tasks.delete(task));
  }
  app.post('/api/factory/releases/:id/shorts-storyboard',{logLevel:'silent'},async(req,reply)=>{
    uuid.parse((req.params as {id:string}).id);
    return reply.code(409).send({error:'Storyboard-картинки вимкнено. Для Shorts зберігаємо лише шість відеопромптів.'});
  });
  app.post('/api/factory/releases/:id/shorts-plan',async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id),{regenerate}=z.object({regenerate:z.boolean().optional().default(false)}).strict().parse(req.body??{});
    const release=await factoryLock(async db=>{
      const current=(await db.query('SELECT * FROM factory_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!current||!['review','private','uncertain'].includes(current.state))throw new FactoryError(409,'План Shorts можна створити лише для готового повного випуску.');
      if(current.short_state==='rendering')throw new FactoryError(409,'Shorts уже монтується. Дочекайся завершення.');
      if(regenerate&&current.short_publish_state)throw new FactoryError(409,'Опублікований Shorts не змінюємо автоматично.');
      return reserveShortStory(db,current,regenerate);
    });
    return reply.code(release.short_plan&&regenerate?201:200).send({id,plan:release.short_plan});
  });
  app.post('/api/factory/releases/:id/shorts-clips',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id),position=z.coerce.number().int().min(0).max(5).parse((req.query as {position?:string}).position);
    const release=(await requirePool().query("SELECT id,state,short_plan FROM factory_releases WHERE id=$1",[id])).rows[0];
    if(!release||!['review','private','uncertain'].includes(release.state))throw new FactoryError(409,'Спочатку підготуй повний випуск і план Shorts.');
    if(!release.short_plan)throw new FactoryError(409,'Спочатку підготуй план Shorts.');
    const part=await req.file();if(!part)throw new FactoryError(400,'Обери відеофрагмент.');
    const data=await part.toBuffer();if(part.file.truncated||data.length>UPLOAD_MAX||data.length<16)throw new FactoryError(400,'Відеофрагмент має бути до 25 МіБ.');
    let kind:'mp4'|'webm';try{kind=videoKind(data.subarray(0,16));}catch(error){throw new FactoryError(400,error instanceof Error?error.message:'Потрібен відеофрагмент MP4 або WebM.');}
    let duration:number|null=null,dir:string|undefined;
    try{
      dir=await mkdtemp(join(tmpdir(),'veil-short-clip-'));const file=join(dir,'clip.'+kind);await writeFile(file,data);
      if(options.probe)duration=await options.probe(file,kind);
      else {const result=JSON.parse(await runMediaTool(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-max_alloc','67108864','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type','-of','json',file],15000));duration=Number(result.format?.duration);if(!result.streams?.some((v:{codec_type:string})=>v.codec_type==='video'))duration=0;}
      if(!Number.isFinite(duration)||duration!<0.25||duration!>60)throw new FactoryError(400,'Відеофрагмент має тривати від 0,25 до 60 секунд.');
      const hash=createHash('sha256').update(data).digest('hex'),saved=await reserveAsset(needStorage(),{kind:'video',hash,name:part.filename.replace(/[<>\x00-\x1f]/g,'').slice(0,150)||`short-scene-${position+1}.${kind}`,bytes:data.length,type:kind==='webm'?'video/webm':'video/mp4',duration,theme:`shorts-video|${id}|${position}`,vocal:'instrumental'});
      if(saved.fresh||saved.asset.state!=='ready'){await needStorage().put(saved.asset.object_key,data,kind==='webm'?'video/webm':'video/mp4');await requirePool().query("UPDATE factory_assets SET state='ready',bytes=$2,type=$3,duration=$4,theme=$5 WHERE id=$1",[saved.asset.id,data.length,kind==='webm'?'video/webm':'video/mp4',duration,`shorts-video|${id}|${position}`]);}
      await factoryLock(async db=>{await db.query(`INSERT INTO factory_short_clips(release_id,position,asset_id) VALUES($1,$2,$3)
        ON CONFLICT(release_id,position) DO UPDATE SET asset_id=EXCLUDED.asset_id,created_at=NOW()`,[id,position,saved.asset.id]);await db.query("UPDATE factory_releases SET short_plan=short_plan-'clipMatching',short_updated_at=NOW() WHERE id=$1",[id]);});
      return reply.code(201).send({id:saved.asset.id,position,duration,duplicate:!saved.fresh});
    }finally{if(dir)await rm(dir,{recursive:true,force:true});}
  });
  app.post('/api/factory/releases/:id/shorts-arrange',{logLevel:'silent'},async(req)=>{
    const id=uuid.parse((req.params as {id:string}).id);if(!clipOrderer)throw new FactoryError(409,'Автоматичне зіставлення відео недоступне. Підключи OpenAI — система не буде вгадувати порядок за назвами файлів.');
    const release=(await requirePool().query('SELECT id,state,short_plan FROM factory_releases WHERE id=$1',[id])).rows[0];
    const scenes=Array.isArray(release?.short_plan?.scenes)?release.short_plan.scenes:[];
    if(!release||!['review','private','uncertain'].includes(release.state)||scenes.length!==SHORTS_SCENE_COUNT)throw new FactoryError(409,'Спочатку підготуй план із шести сцен.');
    const clips=(await requirePool().query(`SELECT c.position,a.id,a.object_key,a.name,a.duration FROM factory_short_clips c JOIN factory_assets a ON a.id=c.asset_id
      WHERE c.release_id=$1 AND a.kind='video' AND a.state='ready' ORDER BY c.position`,[id])).rows;
    if(clips.length!==SHORTS_SCENE_COUNT)throw new FactoryError(409,'Для автоматичного зіставлення завантаж рівно шість відеофрагментів.');
    const token=await beginHeavyAfterCleanup('аналіз шести сцен Shorts');let dir:string|undefined;
    try{
      dir=await mkdtemp(join(tmpdir(),'veil-short-order-'));const frames:Buffer[]=[];
      for(const [index,clip] of clips.entries()){
        const source=join(dir,`clip-${index}.video`);await storageToFile(needStorage(),clip.object_key,source,UPLOAD_MAX);
        frames.push(await extractClipFrame(source,Number(clip.duration)||1));
      }
      const order=await clipOrderer(frames,scenes);
      if(order.length!==SHORTS_SCENE_COUNT||new Set(order).size!==SHORTS_SCENE_COUNT||order.some(index=>index<0||index>=SHORTS_SCENE_COUNT))throw new FactoryError(409,'ШІ не повернув однозначний порядок шести роликів.');
      const arranged=order.map(index=>clips[index]!);
      const assignments=arranged.map((clip,position)=>({position,name:clip.name,scene:scenes[position]?.label||`Сцена ${position+1}`}));
      await factoryLock(async db=>{await db.query('DELETE FROM factory_short_clips WHERE release_id=$1',[id]);for(const [position,clip] of arranged.entries())await db.query('INSERT INTO factory_short_clips(release_id,position,asset_id) VALUES($1,$2,$3)',[id,position,clip.id]);await db.query("UPDATE factory_releases SET short_plan=jsonb_set(short_plan,'{clipMatching}',$2::jsonb,true),short_updated_at=NOW() WHERE id=$1",[id,JSON.stringify({mode:'ai',assignments})]);});
      return {arranged:true,assignments};
    }finally{if(dir)await rm(dir,{recursive:true,force:true});endHeavy(token);}
  });
  app.post('/api/factory/releases/:id/shorts-manual',{logLevel:'silent'},async(req,reply)=>{
    needStorage();if(!options.render)await checkMediaTools();const id=uuid.parse((req.params as {id:string}).id),{chorusStart}=z.object({chorusStart:z.number().min(0).max(300).optional()}).strict().parse(req.body??{});let heavyToken:symbol|null=await beginHeavyAfterCleanup('монтаж Shorts із відеофрагментів');
    try{
      const {release,fresh}=await factoryLock(async db=>{
        if((await db.query("SELECT id FROM factory_releases WHERE state='rendering' OR short_state='rendering'")).rowCount)throw new FactoryError(409,'Лінія вже монтує відео. Дочекайся завершення.');
        const current=(await db.query("SELECT * FROM factory_releases WHERE id=$1 FOR UPDATE",[id])).rows[0];
        if(!current||!['review','private','uncertain'].includes(current.state)||!current.short_plan)throw new FactoryError(409,'Спочатку підготуй план Shorts.');
        if((current.short_plan.scenes||[]).length<SHORTS_SCENE_COUNT)throw new FactoryError(409,`Перегенеруй план: потрібні ${SHORTS_SCENE_COUNT} пов’язаних сцен.`);
        if(current.short_plan.clipMatching?.mode!=='ai')throw new FactoryError(409,'Спочатку дозволь системі зіставити шість роликів із промптами. Монтаж за випадковим порядком не запускаємо.');
        let plan={...current.short_plan,mode:'manual-video'};
        if(chorusStart!==undefined){const selection=await manualShortsSelection(db,current,chorusStart);plan={...plan,kineticText:{mode:'manual',cues:selection.cues,clipStart:selection.clipStart,clipDuration:selection.clipDuration,section:selection.section}};}
        if(!lyricTranscriber&&!['manual','transcribed'].includes(plan.kineticText?.mode))throw new FactoryError(409,'Познач початок приспіву перед монтажем Shorts.');
        const clips=(await db.query(`SELECT c.position,a.id,a.object_key,a.state,a.duration FROM factory_short_clips c JOIN factory_assets a ON a.id=c.asset_id WHERE c.release_id=$1 AND a.kind='video' AND a.state='ready' ORDER BY c.position`,[id])).rows;
        if(clips.length<SHORTS_SCENE_COUNT)throw new FactoryError(409,`Додай усі ${SHORTS_SCENE_COUNT} відеофрагментів до слотів Shorts.`);
        let outputId=current.short_output_id;
        if(!outputId){await capacity(db,needStorage(),SHORTS_MAX_BYTES);outputId=randomUUID();await db.query("INSERT INTO factory_assets(id,kind,hash,object_key,name,bytes,type,vocal,state) VALUES($1,'video',$2,$3,$4,$5,'video/mp4',$6,'reserved')",[outputId,'manual-short:'+current.id,'factory/'+outputId,current.title+' · Manual Shorts.mp4',SHORTS_MAX_BYTES,current.recipe.vocal]);}
        const updated=(await db.query("UPDATE factory_releases SET short_output_id=$2,short_state='rendering',short_stage='queued',short_progress=1,short_progress_detail='Shorts поставлено в чергу.',short_error=NULL,short_started_at=NOW(),short_render_started_at=NULL,short_processed_seconds=NULL,short_render_duration=NULL,short_updated_at=NOW(),short_plan=$3 WHERE id=$1 RETURNING *",[id,outputId,JSON.stringify(plan)])).rows[0];return {release:updated,fresh:true};
      });
      if(fresh){workShort(release,heavyToken);heavyToken=null;}return reply.code(202).send({id,shortState:release.short_state});
    }finally{if(heavyToken)endHeavy(heavyToken);}
  });
  app.post('/api/factory/releases/:id/shorts',async(req,reply)=>{
    needStorage();if(!options.render)await checkMediaTools();const id=uuid.parse((req.params as {id:string}).id);
    const {chorusStart}=z.object({regenerate:z.boolean().optional().default(false),chorusStart:z.number().min(0).max(300).optional().default(0)}).strict().parse(req.body??{});
    let heavyToken:symbol|null=await beginHeavyAfterCleanup('простий Shorts з субтитрами');
    try{
      const release=await factoryLock(async db=>{
        if((await db.query("SELECT id FROM factory_releases WHERE state='rendering' OR short_state='rendering'")).rowCount)throw new FactoryError(409,'Лінія вже монтує відео. Дочекайся завершення.');
        const current=(await db.query('SELECT * FROM factory_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!current||!['review','private','uncertain'].includes(current.state))throw new FactoryError(409,'Спочатку підготуй повний випуск.');
        if(current.short_publish_state)throw new FactoryError(409,'Уже переданий Shorts не перезаписуємо автоматично.');
        const selection=await manualShortsSelection(db,current,chorusStart);
        let outputId=current.short_output_id;
        if(!outputId){await capacity(db,needStorage(),SHORTS_MAX_BYTES);outputId=randomUUID();await db.query("INSERT INTO factory_assets(id,kind,hash,object_key,name,bytes,type,vocal,state) VALUES($1,'video',$2,$3,$4,$5,'video/mp4',$6,'reserved')",[outputId,'simple-short:'+current.id,'factory/'+outputId,current.title+' · Shorts.mp4',SHORTS_MAX_BYTES,current.recipe.vocal]);}
        const base=current.short_plan||{version:1,format:'story',source:'lyrics-ai',sourceNote:'Простий Shorts використовує збережені слова пісні.',hook:current.title,story:'',identity:'',scenes:[],kineticText:{mode:'pending',cues:[]}};
        const plan={...base,mode:'simple-cover',kineticText:{mode:'manual',cues:selection.cues,clipStart:selection.clipStart,clipDuration:selection.clipDuration,section:selection.section}};
        return (await db.query("UPDATE factory_releases SET short_output_id=$2,short_plan=$3,short_state='rendering',short_stage='queued',short_progress=1,short_progress_detail='Shorts поставлено в чергу.',short_error=NULL,short_started_at=NOW(),short_render_started_at=NULL,short_processed_seconds=NULL,short_render_duration=NULL,short_updated_at=NOW() WHERE id=$1 RETURNING *",[id,outputId,JSON.stringify(plan)])).rows[0];
      });
      workShort(release,heavyToken);heavyToken=null;return reply.code(202).send({id,shortState:release.short_state,mode:'simple-cover'});
    }finally{if(heavyToken)endHeavy(heavyToken);}
  });
  app.post('/api/factory/releases/:id/cancel',async req=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const mode=await factoryLock(async db=>{
      const release=(await db.query('SELECT state,short_state FROM factory_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!release)throw new FactoryError(404,'Випуск не знайдено.');
      if(release.state==='rendering'){await db.query("UPDATE factory_releases SET state='failed',stage='interrupted',progress_detail='Процес скасовано вручну.',error='Монтаж скасовано. Можна повторити з одним образом і тими самими матеріалами.',updated_at=NOW() WHERE id=$1",[id]);return 'video';}
      if(release.short_state==='rendering'){await db.query("UPDATE factory_releases SET short_state='failed',short_stage='interrupted',short_progress_detail='Створення скасовано вручну.',short_error='Створення Shorts скасовано. Можна безпечно повторити.',short_updated_at=NOW() WHERE id=$1",[id]);return 'shorts';}
      throw new FactoryError(409,'Активного процесу для скасування немає.');
    });
    jobs.get(id)?.abort();return {cancelled:true,mode};
  });
  function work(release:Record<string,any>,heavyToken:symbol){
    bindHeavyRelease(heavyToken,release.id);
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
        if(stage==='rendering'&&error instanceof MediaToolError&&error.reason==='spawn')return `FFmpeg не запустився. Потрібно перевірити інструменти ${config.VEIL_LOCAL_MODE?'на цьому ПК':'Render'}.`;
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
        for(const [index,scene] of scenes.entries()){
          if(scene.state==='ready'){
            if(!localWorkerConfigured()){
              await update('downloading',10+index*5,`Отримуємо образ ${index+1} із ${scenes.length} з R2.`,true);
              await storageToFile(s,scene.object_key,images[index]!,8*1024*1024);
            }
          }else{
            if(release.recipe.coverMode!=='ai'||!imageGenerator)throw Error('Image generator unavailable');
            await update('generating-image',10+index*6,`${configuredImageProvider||'Генератор'} створює образ ${index+1} із ${scenes.length}: ${scene.label}.`,true);
            const generated=await imageGenerator(scene.prompt,Number(scene.seed),controller.signal);
            await update('saving-cover',14+index*6,`Зберігаємо образ ${index+1} із ${scenes.length} у R2.`,true);
            await s.put(scene.object_key,generated.data,generated.type);await writeFile(images[index]!,generated.data);
            await requirePool().query("UPDATE factory_assets SET state='ready',bytes=$2,type=$3 WHERE id=$1",[scene.asset_id,generated.data.length,generated.type]);
          }
        }
        if(localWorkerConfigured()){
          await update('waiting-local',25,'Матеріали готові. Чекаємо, коли локальна монтажна станція на твоєму ПК забере завдання.',true);
          await writes;return;
        }
        await update('downloading',27,'Отримуємо музику з приватного сховища R2.',true);
        await storageToFile(s,track.object_key,audio,UPLOAD_MAX);
        await waitForMemory(controller.signal,budget=>{void update('waiting-memory',30,`Пауза між етапами: пам’ять зайнята на ${Math.round(budget.ratio*100)}%. Матеріали вже збережено.`,true);});
        await requirePool().query("UPDATE factory_releases SET render_started_at=NOW(),processed_seconds=0,render_duration=NULL,updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id]);
        await update('rendering',31,`Запускаємо монтаж V2: ${scenes.length} сцени, атмосфера і звук.`,true);
        const renderEffects=(release.recipe.productionPlan?.effects??ACTIVE_EFFECT_IDS).filter((id:string)=>id!=='camera.center-push');
        await (options.render??renderMedia)(images,audio,video,track.type==='audio/wav'?'wav':'mp3',controller.signal,'video',release.recipe.visualPreset,p=>{
          const processed=Math.min(p.duration,p.seconds),overall=31+p.percent*.57;
          const clock=(seconds:number)=>Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');
          void update('rendering',overall,'Змонтовано '+clock(processed)+' із '+clock(p.duration)+' музики.',false,{seconds:processed,duration:p.duration});
        },release.recipe.motionIntensity||'cinematic',renderEffects);
        await update('verifying',91,'Перевіряємо тривалість, звук, роздільність і розмір відео.',true);
        const size=(await stat(video)).size;if(size>MAX_OUTPUT_BYTES)throw Error('Output exceeds reservation');
        await waitForMemory(controller.signal,budget=>{void update('waiting-memory',95,`Монтаж збережено. Чекаємо звільнення пам’яті перед передачею (${Math.round(budget.ratio*100)}%).`,true);});
        await update('uploading',96,'Передаємо готове відео до приватного сховища R2.',true);
        await fileToStorage(s,output.object_key,video,'video/mp4');
        await writes;
        await factoryLock(async db=>{
          await db.query("UPDATE factory_assets SET state='ready',bytes=$2 WHERE id=$1",[output.id,size]);
          await db.query("UPDATE factory_releases SET state='review',stage='complete',progress=100,progress_detail='Відео готове до твоєї перевірки.',error=NULL,updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id]);
        });
      }catch(error){
        await writes;
        const reason=error instanceof MediaToolError?error.reason:'operation';
        app.log.error({releaseId:release.id,stage,reason},'Factory release failed');
        await requirePool().query("UPDATE factory_releases SET state='failed',stage=$2,progress=$3,progress_detail='Зупинено на цьому етапі.',error=$4,updated_at=NOW() WHERE id=$1 AND state='rendering'",[release.id,stage,progress,failure(error)]).catch(()=>{});
      }finally{if(jobs.get(release.id)===controller)jobs.delete(release.id);if(dir)await rm(dir,{recursive:true,force:true});endHeavy(heavyToken);}
    })();tasks.add(task);void task.finally(()=>tasks.delete(task));
  }
  app.post('/api/factory/releases',async(req,reply)=>{
    const {requestKey,channelId,ideaId}=z.object({requestKey:uuid,channelId:containerId.default('veil-of-ages'),ideaId:uuid.optional()}).strict().parse(req.body);
    const existing=(await requirePool().query('SELECT id,state FROM factory_releases WHERE request_key=$1',[requestKey])).rows[0];
    if(existing)return reply.code(200).send({id:existing.id,state:existing.state});
    const s=needStorage();if(!options.render&&!localWorkerConfigured())await checkMediaTools();let heavyToken:symbol|null=await beginHeavyAfterCleanup('підготовка повного відео');
    try{const {release,fresh}=await startRelease(s,requestKey,!!imageGenerator,channelId,ideaId);if(fresh){work(release,heavyToken);heavyToken=null;}
    return reply.code(fresh?202:200).send({id:release.id,state:release.state});}
    finally{if(heavyToken)endHeavy(heavyToken);}
  });
  app.post('/api/factory/releases/:id/retry',async(req,reply)=>{
    needStorage();const id=uuid.parse((req.params as {id:string}).id);let heavyToken:symbol|null=await beginHeavyAfterCleanup('повтор монтажу');
    try{const release=await factoryLock(async db=>{
      if((await db.query("SELECT id FROM factory_releases WHERE state='rendering' OR short_state='rendering'")).rowCount)throw new FactoryError(409,'Лінія зайнята.');
      const r=(await db.query("UPDATE factory_releases SET state='rendering',stage='preparing',progress=2,progress_detail='Готуємо безпечний повтор із тими самими матеріалами.',recipe=jsonb_set(recipe,'{productionPlan,sceneCount}','1'::jsonb,true),error=NULL,started_at=NOW(),render_started_at=NULL,processed_seconds=NULL,render_duration=NULL,local_worker_id=NULL,local_worker_lease_hash=NULL,local_worker_lease_until=NULL,updated_at=NOW() WHERE id=$1 AND state='failed' RETURNING *",[id])).rows[0];
      if(!r)throw new FactoryError(409,'Повтор доступний лише для невдалого складання.');return r;
    });bindHeavyRelease(heavyToken,release.id);work(release,heavyToken);heavyToken=null;return reply.code(202).send({id});}
    finally{if(heavyToken)endHeavy(heavyToken);}
  });
  app.post('/api/factory/releases/:id/resolve-upload',async req=>{
    const id=uuid.parse((req.params as {id:string}).id),body=z.discriminatedUnion('action',[
      z.object({target:z.enum(['video','shorts']),action:z.literal('reconcile')}).strict(),
      z.object({target:z.enum(['video','shorts']),action:z.literal('attach'),videoId:z.string().regex(/^[A-Za-z0-9_-]{11}$/)}).strict(),
      z.object({target:z.enum(['video','shorts']),action:z.literal('reset'),confirmation:z.literal('NOT_ON_YOUTUBE')}).strict(),
      z.object({target:z.enum(['video','shorts']),action:z.literal('reroute'),confirmation:z.literal('WRONG_CHANNEL')}).strict()
    ]).parse(req.body);
    const assetColumn=body.target==='video'?'r.output_id':'r.short_output_id';
    const snapshot=(await requirePool().query(`SELECT r.state,r.short_publish_state,a.object_key FROM factory_releases r JOIN factory_assets a ON a.id=${assetColumn} WHERE r.id=$1`,[id])).rows[0];
    if(!snapshot)throw new FactoryError(404,'Випуск або його відеофайл не знайдено.');
    const snapshotUncertain=body.target==='video'?snapshot.state==='uncertain':snapshot.short_publish_state==='uncertain';
    const snapshotPrivate=body.target==='video'?snapshot.state==='private':snapshot.short_publish_state==='private';
    if(!snapshotUncertain&&!(body.action==='reroute'&&snapshotPrivate))throw new FactoryError(409,'Ця передача вже не потребує відновлення. Онови сторінку.');
    const uploadHash=createHash('sha256').update(await needStorage().get(snapshot.object_key,MAX_OUTPUT_BYTES)).digest('hex');
    return factoryLock(async db=>{
      const release=(await db.query('SELECT * FROM factory_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!release)throw new FactoryError(404,'Випуск не знайдено.');
      const uncertain=body.target==='video'?release.state==='uncertain':release.short_publish_state==='uncertain';
      const isPrivate=body.target==='video'?release.state==='private':release.short_publish_state==='private';
      if(!uncertain&&!(body.action==='reroute'&&isPrivate))throw new FactoryError(409,'Ця передача вже не потребує відновлення. Онови сторінку.');
      if(body.action==='reroute'){
        await db.query('DELETE FROM youtube_uploads WHERE file_hash=$1',[uploadHash]);
        if(body.target==='video')await db.query("UPDATE factory_releases SET state='review',video_id=NULL,error=NULL,updated_at=NOW() WHERE id=$1",[id]);
        else await db.query("UPDATE factory_releases SET short_publish_state=NULL,short_video_id=NULL,short_publish_error=NULL,updated_at=NOW() WHERE id=$1",[id]);
        return {reconciled:false,retryAllowed:true,wrongChannelCleared:true};
      }
      if(body.action==='attach'){
        await db.query("INSERT INTO youtube_uploads(file_hash,state,video_id) VALUES($1,'complete',$2) ON CONFLICT(file_hash) DO UPDATE SET state='complete',video_id=EXCLUDED.video_id",[uploadHash,body.videoId]);
        if(body.target==='video')await db.query("UPDATE factory_releases SET state='private',video_id=$2,error='Ролик прив’язано з YouTube Studio. Повтори встановлення обкладинки.',updated_at=NOW() WHERE id=$1",[id,body.videoId]);
        else await db.query("UPDATE factory_releases SET short_publish_state='private',short_video_id=$2,short_publish_error=NULL,updated_at=NOW() WHERE id=$1",[id,body.videoId]);
        return {reconciled:true,videoId:body.videoId,attached:true};
      }
      const upload=(await db.query('SELECT state,video_id FROM youtube_uploads WHERE file_hash=$1',[uploadHash])).rows[0];
      if(upload?.state==='complete'&&/^[A-Za-z0-9_-]{11}$/.test(upload.video_id||'')){
        if(body.target==='video')await db.query("UPDATE factory_releases SET state='private',video_id=$2,error='Відео знайдено серед завершених передач. За потреби повтори встановлення обкладинки.',updated_at=NOW() WHERE id=$1",[id,upload.video_id]);
        else await db.query("UPDATE factory_releases SET short_publish_state='private',short_video_id=$2,short_publish_error=NULL,updated_at=NOW() WHERE id=$1",[id,upload.video_id]);
        return {reconciled:true,videoId:upload.video_id};
      }
      if(body.action==='reconcile')throw new FactoryError(409,'Завершену передачу не знайдено. Перевір YouTube Studio. Якщо ролика там немає, дозволь нову спробу окремою кнопкою.');
      await db.query("DELETE FROM youtube_uploads WHERE file_hash=$1 AND state<>'complete'",[uploadHash]);
      if(body.target==='video')await db.query("UPDATE factory_releases SET state='review',video_id=NULL,error=NULL,updated_at=NOW() WHERE id=$1",[id]);
      else await db.query("UPDATE factory_releases SET short_publish_state=NULL,short_video_id=NULL,short_publish_error=NULL,updated_at=NOW() WHERE id=$1",[id]);
      return {reconciled:false,retryAllowed:true};
    });
  });
  app.post('/api/factory/releases/:id/verify-youtube',async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id),body=z.object({target:z.enum(['video','shorts'])}).strict().parse(req.body);
    const release=(await requirePool().query('SELECT state,video_id,short_publish_state,short_video_id FROM factory_releases WHERE id=$1',[id])).rows[0];
    if(!release)throw new FactoryError(404,'Випуск не знайдено.');
    const videoId=body.target==='video'?release.video_id:release.short_video_id;
    if(!/^[A-Za-z0-9_-]{11}$/.test(videoId||''))throw new FactoryError(409,'Для цієї передачі ще немає підтвердженого ID YouTube.');
    const result=await app.inject({method:'POST',url:'/youtube/video-status?'+new URLSearchParams({videoId}),headers:{cookie:req.headers.cookie??'',origin:ownerOrigin()}});
    const data=result.json();
    if(result.statusCode!==200)return reply.code(result.statusCode===409?409:502).send({error:data.error||'Не вдалося перевірити ролик у YouTube.'});
    if(data.state==='missing'||data.state==='failed'){
      if(body.target==='video')await requirePool().query("UPDATE factory_releases SET state='uncertain',error=$2,updated_at=NOW() WHERE id=$1",[id,data.detail+' Перевір YouTube Studio; якщо ролика там немає, дозволь нову передачу.']);
      else await requirePool().query("UPDATE factory_releases SET short_publish_state='uncertain',short_publish_error=$2,updated_at=NOW() WHERE id=$1",[id,data.detail+' Перевір YouTube Studio; якщо Shorts там немає, дозволь нову передачу.']);
    }
    return data;
  });
  app.post('/api/factory/releases/:id/publish',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const meta=z.object({children:z.enum(['yes','no']),synthetic:z.enum(['yes','no']),rights:z.literal(true)}).strict().parse(req.body);
    const heavyToken=await beginHeavyAfterCleanup('передача повного відео на YouTube');
    let publishDir:string|undefined;
    try{
    await waitForMemory(undefined,budget=>app.log.warn({operation:'youtube-video',memoryPercent:Math.round(budget.ratio*100)},'YouTube upload waits at a safe memory checkpoint'));
    const release=(await requirePool().query("UPDATE factory_releases SET state='publishing',updated_at=NOW() WHERE id=$1 AND state='review' RETURNING *",[id])).rows[0];
    if(!release)throw new FactoryError(409,'Випуск не готовий або вже передавався. Не повторюй невідоме завантаження без перевірки YouTube.');
    bindHeavyRelease(heavyToken,id);
    let mayHaveUploaded=false;
    try{
      const a=(await requirePool().query('SELECT * FROM factory_assets WHERE id=$1',[release.output_id])).rows[0];
      publishDir=await mkdtemp(join(tmpdir(),'veil-publish-'));const file=join(publishDir,'video.mp4');await storageToFile(needStorage(),a.object_key,file,MAX_OUTPUT_BYTES);
      const data=await publishVideo(file,{title:release.title,children:meta.children,synthetic:meta.synthetic,description:String(release.recipe?.youtubeDescription||'Original music release from Veil of Ages.'),tags:Array.isArray(release.recipe?.youtubeTags)?release.recipe.youtubeTags:[]});mayHaveUploaded=true;
      let thumbnailWarning:string|null=null;
      try{await attachYoutubeThumbnail(release,data.videoId,req.headers.cookie??'');}
      catch(error){thumbnailWarning=error instanceof FactoryError?error.message:'Відео завантажено приватно, але YouTube не підтвердив власну обкладинку.';}
      await requirePool().query("UPDATE factory_releases SET state='private',video_id=$2,error=$3,updated_at=NOW() WHERE id=$1",[id,data.videoId,thumbnailWarning]);return {videoId:data.videoId,thumbnailSet:!thumbnailWarning,warning:thumbnailWarning};
    }catch(error){
      if(error instanceof YoutubeUploadOutcomeError)mayHaveUploaded=error.uncertain;
      if(!mayHaveUploaded){const message=error instanceof FactoryError?error.message:'Передача не почалася. Перевір підключення YouTube і повтори спробу.';await requirePool().query("UPDATE factory_releases SET state='review',error=$2,updated_at=NOW() WHERE id=$1",[id,message]);throw error instanceof FactoryError?error:new FactoryError(502,message);}
      await requirePool().query("UPDATE factory_releases SET state='uncertain',error='Передачу не підтверджено. Перевір YouTube Studio; автоматичний повтор заблоковано.',updated_at=NOW() WHERE id=$1",[id]);
      return reply.code(502).send({error:'Перевір YouTube Studio перед повторними діями. Результат передачі невідомий.'});
    }
    }finally{if(publishDir)await rm(publishDir,{recursive:true,force:true});endHeavy(heavyToken);}
  });
  app.post('/api/factory/releases/:id/publish-short',{logLevel:'silent'},async(req,reply)=>{
    const id=uuid.parse((req.params as {id:string}).id);
    const meta=z.object({children:z.enum(['yes','no']),synthetic:z.enum(['yes','no']),rights:z.literal(true)}).strict().parse(req.body);
    const heavyToken=await beginHeavyAfterCleanup('передача Shorts на YouTube');
    let publishDir:string|undefined;
    try{
    await waitForMemory(undefined,budget=>app.log.warn({operation:'youtube-shorts',memoryPercent:Math.round(budget.ratio*100)},'YouTube upload waits at a safe memory checkpoint'));
    const release=(await requirePool().query("UPDATE factory_releases SET short_publish_state='publishing',short_publish_error=NULL,updated_at=NOW() WHERE id=$1 AND state IN ('review','private','uncertain') AND short_state='review' AND short_output_id IS NOT NULL AND short_publish_state IS NULL RETURNING *",[id])).rows[0];
    if(!release)throw new FactoryError(409,'Shorts не готовий або вже передавався. Не повторюй невідоме завантаження без перевірки YouTube.');
    bindHeavyRelease(heavyToken,id);
    let mayHaveUploaded=false;
    try{
      const asset=(await requirePool().query("SELECT * FROM factory_assets WHERE id=$1 AND kind='video' AND state='ready'",[release.short_output_id])).rows[0];
      if(!asset)throw Error('Shorts asset not ready');
      publishDir=await mkdtemp(join(tmpdir(),'veil-publish-short-'));const file=join(publishDir,'shorts.mp4');await storageToFile(needStorage(),asset.object_key,file,MAX_OUTPUT_BYTES);
      const tags=Array.isArray(release.recipe?.youtubeTags)?[...release.recipe.youtubeTags,'Shorts']:['Viking music','Veil of Ages','Shorts'];
      const description=String(release.recipe?.youtubeDescription||'Original Viking song from Veil of Ages.')+'\n\nListen to the full song on Veil of Ages. #Shorts';
      const title=(release.title+' | Viking Song #Shorts').slice(0,100);
      const data=await publishVideo(file,{title,children:meta.children,synthetic:meta.synthetic,description,tags});mayHaveUploaded=true;
      let thumbnailWarning:string|null=null;
      try{await attachShortsYoutubeThumbnail({id:release.id,title:release.title,cover_id:release.short_cover_id||release.cover_id},data.videoId,req.headers.cookie??'');}
      catch(error){thumbnailWarning=error instanceof FactoryError?error.message:'Shorts завантажено приватно, але YouTube не підтвердив власну обкладинку.';}
      await requirePool().query("UPDATE factory_releases SET short_publish_state='private',short_video_id=$2,short_publish_error=$3,updated_at=NOW() WHERE id=$1",[id,data.videoId,thumbnailWarning]);
      return {videoId:data.videoId,thumbnailSet:!thumbnailWarning,warning:thumbnailWarning};
    }catch(error){
      if(error instanceof YoutubeUploadOutcomeError)mayHaveUploaded=error.uncertain;
      if(!mayHaveUploaded){const message=error instanceof FactoryError?error.message:'Передача Shorts не почалася. Перевір підключення YouTube і повтори спробу.';await requirePool().query("UPDATE factory_releases SET short_publish_state=NULL,short_publish_error=$2,updated_at=NOW() WHERE id=$1",[id,message]);throw error instanceof FactoryError?error:new FactoryError(502,message);}
      await requirePool().query("UPDATE factory_releases SET short_publish_state='uncertain',short_publish_error='Передачу Shorts не підтверджено. Перевір YouTube Studio; автоматичний повтор заблоковано.',updated_at=NOW() WHERE id=$1",[id]);
      return reply.code(502).send({error:'Перевір YouTube Studio: результат передачі Shorts невідомий.'});
    }
    }finally{if(publishDir)await rm(publishDir,{recursive:true,force:true});endHeavy(heavyToken);}
  });
}
