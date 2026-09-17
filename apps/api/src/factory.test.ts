import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import { factoryScript } from './factory-ui.js';
import { createObjectStore, INPUT_LIMIT, STORAGE_LIMIT, type ObjectStore } from './factory-storage.js';
process.env.DATABASE_URL='postgresql://test:test@localhost/test';
process.env.PUBLIC_API_URL='https://api.example.test';
const { pool }=await import('./db.js');
const { chooseVisualPreset, factoryMigration, reserveAsset }=await import('./factory-store.js');
const { buildReleaseConcept,buildShortsConcept,buildShortsStoryPlan }=await import('./factory-ai.js');
const { factorySongMigration }=await import('./factory-song.js');
const { buildYoutubeThumbnail,buildShortsArtwork,buildShortsStoryArtwork }=await import('./factory-thumbnail.js');
const { factoryRoutes }=await import('./factory.js');

test('factory browser script parses and storage fails closed without configuration',()=>{
  new Script(factoryScript);
  assert.match(factoryScript,/video\.poster=thumbnailUrl/);
  assert.match(factoryScript,/Повторити встановлення обкладинки/);
  assert.match(factoryScript,/Створити Shorts на 30 секунд/);
  assert.match(factoryScript,/Опублікувати саме Shorts/);
  assert.match(factoryScript,/Створити інший вертикальний образ/);
  assert.match(factoryScript,/Підготувати сюжет Shorts/);
  assert.match(factoryScript,/function shortPlanView/);
  assert.match(factoryScript,/Створити сюжетний Shorts/);
  assert.match(factoryScript,/Завантажити повне відео приватно на YouTube/);
  assert.match(factoryScript,/form\.hidden=!!active/);
  assert.match(factoryScript,/Копіювати назву/);
  assert.match(factoryScript,/Монтувати відео/);
  assert.match(factoryScript,/busy=false;await load\(\);await usage\(\)/);
  assert.match(factoryScript,/new XMLHttpRequest\(\)/);
  assert.match(factoryScript,/request\.timeout=120000/);
  assert.doesNotMatch(factoryScript,/function ideas\(\)/);
  assert.match(factoryScript,/Скасувати процес/);
  assert.match(factoryScript,/ideas\.some\(idea=>idea\.state==='generating'\)/);
  assert.match(factoryScript,/Згенерувати інший варіант/);
  assert.match(factoryScript,/Скасувати задум/);
  assert.match(factoryScript,/Попередній результат збережено в історії як відхилений/);
  assert.match(factoryScript,/function compactReleaseCards/);
  assert.match(factoryScript,/function shortsClips/);
  assert.match(factoryScript,/shorts-clip/);
  assert.match(factoryScript,/clipForm/);
  assert.match(factoryScript,/function notes/);
  assert.match(factoryScript,/notesPending/);
  assert.match(factoryScript,/noteForm'\)\.requestSubmit/);
  assert.match(factoryScript,/function uploadRecovery/);
  assert.match(factoryScript,/NOT_ON_YOUTUBE/);
  assert.match(factoryScript,/\['review','private','uncertain'\]\.includes\(r\.state\)/);
  assert.match(factoryScript,/uploadRecovery\(r,'shorts'\)/);
  assert.match(factoryScript,/details\.open=needsAttention/);
  assert.match(factoryScript,/Розгорнути/);
  const before=process.env.R2_ACCOUNT_ID;delete process.env.R2_ACCOUNT_ID;
  assert.equal(createObjectStore(),null);
  if(before)process.env.R2_ACCOUNT_ID=before;
});

test('factory chooses a cinematic look without repeating one hard-coded result',()=>{
  assert.equal(chooseVisualPreset('auto','00'.repeat(32),'winter ruins'),'moonlit-ruins');
  assert.equal(chooseVisualPreset('auto','00'.repeat(32),'firelit tavern'),'ember-glow');
  assert.equal(chooseVisualPreset('ancient-mist','ff'.repeat(32),''),'ancient-mist');
});

test('factory creates a stable three-part visual story',()=>{
  const concept=buildReleaseConcept('ab'.repeat(32));
  assert.equal(concept.scenes.length,3);
  assert.deepEqual(concept.scenes.map(scene=>scene.label),['Вступ','Розвиток','Кульмінація']);
  assert.equal(new Set(concept.scenes.map(scene=>scene.hash)).size,3);
  assert.deepEqual(concept,buildReleaseConcept('ab'.repeat(32)));
});

test('factory asks for a dedicated safe portrait composition for Shorts',()=>{
  const concept=buildShortsConcept('release-1','Gold Beneath the Snow',{youtubeDescription:'Two travelers return to a winter fjord. #Shorts'});
  assert.match(concept.prompt,/vertical 9:16/);assert.match(concept.prompt,/central 55%/);assert.match(concept.prompt,/never crop a person/);assert.doesNotMatch(concept.prompt,/#Shorts/);
});

test('factory creates a reviewable three-scene Shorts micro-story',()=>{
  const plan=buildShortsStoryPlan('release-1','Gold Beneath the Snow',{youtubeDescription:'Two travelers return to a winter fjord after a broken oath. #Shorts'});
  assert.equal(plan.format,'story');assert.equal(plan.scenes.length,3);assert.ok(plan.hook.length<=96);
  assert.deepEqual(plan.scenes.map(scene=>scene.label),['Гачок','Вибір','Кульмінація']);
  assert.equal(new Set(plan.scenes.map(scene=>scene.hash)).size,3);
  for(const scene of plan.scenes){assert.match(scene.prompt,/VERTICAL 9:16 COMPOSITION/);assert.match(scene.prompt,/Character continuity anchor/);}
});

test('factory builds a bounded branded YouTube thumbnail',async()=>{
  const source=Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#31513a"/></svg>');
  const thumbnail=await buildYoutubeThumbnail(source,'Oath Beneath the Winter Mountain');
  assert.deepEqual([...thumbnail.subarray(0,3)],[0xff,0xd8,0xff]);
  assert.ok(thumbnail.length<2*1024*1024);
});

test('factory composes a vertical branded Shorts frame',async()=>{
  const source=Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#31513a"/></svg>');
  const artwork=await buildShortsArtwork(source,'The Bell Beneath the Ice');const metadata=await sharp(artwork).metadata();
  assert.equal(metadata.width,720);assert.equal(metadata.height,1280);assert.equal(metadata.format,'jpeg');
  const opening=await buildShortsStoryArtwork(source,'The Bell Beneath the Ice',0,'They returned without the final longship');const openingMetadata=await sharp(opening).metadata();assert.equal(openingMetadata.width,720);assert.equal(openingMetadata.height,1280);
  const middle=await buildShortsStoryArtwork(source,'The Bell Beneath the Ice',1,'Unused hook');assert.equal((await sharp(middle).metadata()).height,1280);
});

test('factory: durable library, quotas, duplicates, reservation, retry, review and private upload',async()=>{
  const db=new PGlite();const originalQuery=pool!.query,originalConnect=pool!.connect;
  const q=async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};};
  pool!.query=q as typeof originalQuery;
  let tail=Promise.resolve();pool!.connect=(async()=>{const before=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);await before;return {query:q,release};}) as typeof originalConnect;
  const objects=new Map<string,Buffer>();let otherBytes=0,puts=0,deletes=0,failPut=false,renderFail=true,renders=0,generated=0;const renderPresets:string[]=[],renderSceneCounts:number[]=[],renderFormats:string[]=[],imageFormats:string[]=[];
  const storage:ObjectStore={usage:async()=>otherBytes+[...objects.values()].reduce((n,b)=>n+b.length,0),put:async(k,b)=>{puts++;if(failPut)throw Error('secret never leak');objects.set(k,b);},get:async(k,max)=>{const b=objects.get(k);if(!b||b.length>max)throw Error('not found');return b;},delete:async k=>{deletes++;objects.delete(k);}};
  const app=Fastify();let authorized=true;
  app.decorateRequest('ownerSession',undefined);app.addHook('onRequest',async req=>{if(authorized)req.ownerSession={token_hash:'test',google_sub:'test',verified:true,enrollment_encrypted:null};});
  app.addContentTypeParser('video/mp4',{parseAs:'buffer'},(_req,b,done)=>done(null,b));
  app.addContentTypeParser('image/jpeg',{parseAs:'buffer'},(_req,b,done)=>done(null,b));
  let published=0,thumbnails=0,rejectThumbnail=true;app.post('/youtube/upload',async req=>{published++;assert.equal((req.query as {children:string}).children,'no');return {videoId:'abcdefghijk'};});
  app.post('/youtube/thumbnail',async(_req,reply)=>{thumbnails++;return rejectThumbnail?reply.code(409).send({error:'YouTube ще не підтвердив обкладинку.'}):{ok:true};});
  await app.register(factoryRoutes,{storage,probe:async()=>120,publisher:async(_path:string,metadata:{children:'yes'|'no'})=>{published++;assert.equal(metadata.children,'no');return {videoId:'abcdefghijk',duplicate:false};},imageGenerator:async(_prompt:string,_seed:number,_signal?:AbortSignal,imageOptions?:{format?:'landscape'|'portrait'})=>{generated++;imageFormats.push(imageOptions?.format||'landscape');return {data:Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#31513a"/></svg>'),type:'image/png'};},render:async(images:string|string[],_audio:string,out:string,_kind:string,_signal?:AbortSignal,format?:'video'|'shorts',preset?:string,onProgress?:(p:{percent:number;seconds:number;duration:number})=>void)=>{renders++;renderFormats.push(format||'video');renderSceneCounts.push(Array.isArray(images)?images.length:1);if(preset)renderPresets.push(preset);onProgress?.({percent:50,seconds:60,duration:120});if(renderFail)throw Error('test render interruption');await writeFile(out,Buffer.from('0000ftypisom-fake-render-test'));}});
  const headers={origin:'https://api.example.test'};
  const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers,payload});
  const upload=(kind:string,body:Buffer,name:string)=>app.inject({method:'POST',url:'/api/factory/assets?kind='+kind+'&vocal=instrumental',headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="'+name+'"\r\nContent-Type: application/octet-stream\r\n\r\n'),body,Buffer.from('\r\n--testboundary--\r\n')])});
  const uploadIdea=(body:Buffer,name:string,ideaId:string,theme='')=>app.inject({method:'POST',url:'/api/factory/assets?kind=audio&ideaId='+ideaId+'&theme='+encodeURIComponent(theme),headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="'+name+'"\r\nContent-Type: application/octet-stream\r\n\r\n'),body,Buffer.from('\r\n--testboundary--\r\n')])});
  const waitState=async(id:string,state:string)=>{for(let i=0;i<100;i++){const r=(await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string};if(r.state===state)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected '+state);};
  try{
    await db.exec(factoryMigration);await db.exec(factorySongMigration);await db.exec("CREATE TABLE youtube_uploads(file_hash TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('uploading','complete','uncertain')),video_id TEXT)");
    authorized=false;assert.equal((await app.inject('/api/factory')).statusCode,401);authorized=true;
    const factoryHtml=await app.inject('/factory');assert.match(factoryHtml.body,/\/factory\/icon\.svg/);assert.match(factoryHtml.body,/Тіллі Сміт: урок, що врятував пляж/);assert.match(factoryHtml.body,/Wan 2\.2 \+ ComfyUI/);assert.match(factoryHtml.body,/id="clipForm"/);assert.match(factoryHtml.body,/id="noteForm"/);const favicon=await app.inject('/factory/icon.svg');assert.equal(favicon.statusCode,200);assert.match(favicon.headers['content-type']||'',/image\/svg\+xml/);assert.match(favicon.body,/bde998/);
    assert.equal((await app.inject({method:'POST',url:'/api/factory/recipe',headers:{origin:'https://evil.test'},payload:{}})).statusCode,403);
    const newNote=await post('/api/factory/notes',{text:'Зробити сильніший початок Shorts'});assert.equal(newNote.statusCode,201,newNote.body);assert.equal(newNote.json().completed,false);
    const noteId=newNote.json().id;let noteState=(await app.inject('/api/factory')).json();assert.equal(noteState.notes[0].text,'Зробити сильніший початок Shorts');
    const checkedNote=await post('/api/factory/notes/'+noteId+'/toggle',{completed:true});assert.equal(checkedNote.statusCode,200,checkedNote.body);assert.equal(checkedNote.json().completed,true);
    const deletedNote=await post('/api/factory/notes/'+noteId+'/delete',{});assert.equal(deletedNote.statusCode,200,deletedNote.body);noteState=(await app.inject('/api/factory')).json();assert.equal(noteState.notes.length,0);
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40)]),mp3=Buffer.from('ID3-this-is-an-isolated-test-audio');
    const image=await upload('image',png,'castle.png');assert.equal(image.statusCode,201,image.body);
    const audio=await upload('audio',mp3,'Castle.mp3');assert.equal(audio.statusCode,201,audio.body);
    assert.equal(Number(((await q('SELECT COUNT(*) AS count FROM factory_containers')).rows[0] as {count:number}).count),14);
    assert.equal(((await q('SELECT container_id FROM factory_assets WHERE id=$1',[audio.json().id])).rows[0] as {container_id:string}).container_id,'viking-anthem');
    const factoryState=(await app.inject('/api/factory')).json();assert.equal(factoryState.availableByChannel['veil-of-ages'].instrumental,1);
    await q("DELETE FROM factory_channel_containers WHERE channel_id='veil-of-ages'");await q("INSERT INTO factory_channel_containers(channel_id,container_id) VALUES('veil-of-ages','rap')");
    assert.equal((await post('/api/factory/releases',{requestKey:randomUUID(),channelId:'veil-of-ages'})).statusCode,409);
    await q("DELETE FROM factory_channel_containers WHERE channel_id='veil-of-ages'");await q("INSERT INTO factory_channel_containers(channel_id,container_id) VALUES('veil-of-ages','viking-anthem'),('veil-of-ages','viking-rap-duet')");
    const duplicate=await upload('audio',mp3,'Different name.mp3');assert.equal(duplicate.json().duplicate,true);assert.equal(puts,2);
    const clipPayload=Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="01-fjord.mp4"\r\nContent-Type: video/mp4\r\n\r\n'),Buffer.from('0000ftypisom-fake-short-clip'),Buffer.from('\r\n--testboundary--\r\n')]);
    const clip=await app.inject({method:'POST',url:'/api/factory/assets?kind=video&theme='+encodeURIComponent('shorts-clip|01|wan-local|Дзвін під льодом'),headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:clipPayload});assert.equal(clip.statusCode,201,clip.body);
    const clipRow=(await q('SELECT kind,type,theme FROM factory_assets WHERE id=$1',[clip.json().id])).rows[0] as {kind:string;type:string;theme:string};assert.deepEqual(clipRow,{kind:'video',type:'video/mp4',theme:'shorts-clip|01|wan-local|Дзвін під льодом'});
    assert.equal((await post('/api/factory/recipe',{vocal:'instrumental',motionIntensity:'cinematic',coverId:image.json().id,containerIds:['viking-anthem','viking-rap-duet'],revision:2})).statusCode,200);
    assert.equal(Number(((await q("SELECT COUNT(*) AS count FROM factory_channel_containers WHERE channel_id='veil-of-ages'")).rows[0] as {count:number}).count),2);
    assert.equal((await post('/api/factory/recipe',{vocal:'choir',motionIntensity:'expressive',coverId:image.json().id,revision:1})).statusCode,409);
    otherBytes=INPUT_LIMIT;
    await assert.rejects(reserveAsset(storage,{kind:'audio',hash:'new',name:'New',bytes:10,type:'audio/mpeg',duration:120,theme:'',vocal:'instrumental'}),/Запас/);
    otherBytes=STORAGE_LIMIT;
    assert.equal((await post('/api/factory/releases',{requestKey:randomUUID()})).statusCode,409);
    assert.equal((await q('SELECT * FROM factory_releases')).rows.length,0);
    otherBytes=0;
    const key=randomUUID(),start=await post('/api/factory/releases',{requestKey:key});assert.equal(start.statusCode,202,start.body);
    const id=start.json().id;assert.equal((await post('/api/factory/releases',{requestKey:key})).json().id,id);
    await waitState(id,'failed');assert.equal(renders,1);assert.equal(generated,1);assert.deepEqual(renderSceneCounts,[1]);assert.equal((await q('SELECT * FROM factory_release_scenes WHERE release_id=$1',[id])).rows.length,1);
    const stopped=(await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows[0] as {stage:string;progress:number;error:string;started_at:Date;render_started_at:Date;processed_seconds:number;render_duration:number};
    assert.equal(stopped.stage,'rendering');assert.equal(stopped.progress,60);assert.match(stopped.error,/FFmpeg/);assert.ok(stopped.started_at);assert.ok(stopped.render_started_at);assert.equal(stopped.processed_seconds,60);assert.equal(stopped.render_duration,120);
    assert.equal((await post('/api/factory/releases',{requestKey:randomUUID()})).statusCode,409); // Track remains reserved.
    await q("UPDATE factory_releases SET state='rendering' WHERE id=$1",[id]);const cancelled=await post('/api/factory/releases/'+id+'/cancel',{});assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().mode,'video');assert.match(((await q('SELECT error FROM factory_releases WHERE id=$1',[id])).rows[0] as {error:string}).error,/скасовано/i);
    renderFail=false;assert.equal((await post('/api/factory/releases/'+id+'/retry',{})).statusCode,202);
    await waitState(id,'review');assert.equal(renders,2);assert.equal(generated,1);assert.equal(renderPresets.length,2);assert.deepEqual(renderSceneCounts,[1,1]);
    const release=(await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows[0] as {title:string;track_id:string;output_id:string;progress:number;stage:string;recipe:{coverMode:string;prompt:string;motionIntensity:string;productionPlan:{version:number;source:string;sceneCount:number;effects:string[]}}};assert.equal(release.track_id,audio.json().id);assert.equal(release.recipe.coverMode,'ai');assert.match(release.recipe.prompt,/Viking/);assert.equal(release.recipe.motionIntensity,'cinematic');assert.equal(release.recipe.productionPlan.version,2);assert.equal(release.recipe.productionPlan.sceneCount,1);assert.equal(release.recipe.productionPlan.source,'baseline-rules');assert.deepEqual(release.recipe.productionPlan.effects,['look.dark-fantasy-grade','framing.vignette','transition.soft-fades','audio.loudness-master']);assert.equal(release.progress,100);assert.equal(release.stage,'complete');
    assert.equal((await app.inject('/api/factory/assets/'+release.output_id+'/file')).statusCode,200);
    assert.equal((await post('/api/factory/assets/'+release.output_id+'/delete',{confirmation:'DELETE'})).statusCode,409);
    authorized=false;assert.equal((await app.inject('/api/factory/assets/'+release.output_id+'/file')).statusCode,401);authorized=true;
    assert.equal((await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:false})).statusCode,400);assert.equal(published,0);
    const publish=await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:true});assert.equal(publish.statusCode,200,publish.body);assert.equal(published,1);assert.equal(publish.json().thumbnailSet,false);assert.equal(thumbnails,1,publish.body);
    rejectThumbnail=false;const thumbnailRetry=await post('/api/factory/releases/'+id+'/thumbnail',{});assert.equal(thumbnailRetry.statusCode,200,thumbnailRetry.body);assert.equal(thumbnailRetry.json().thumbnailSet,true);assert.equal(thumbnails,2);assert.equal(((await q('SELECT error FROM factory_releases WHERE id=$1',[id])).rows[0] as {error:string|null}).error,null);
    const outputObjectKey=((await q('SELECT object_key FROM factory_assets WHERE id=$1',[release.output_id])).rows[0] as {object_key:string}).object_key,outputHash=createHash('sha256').update(objects.get(outputObjectKey)!).digest('hex');
    await q("INSERT INTO youtube_uploads(file_hash,state,video_id) VALUES($1,'complete','abcdefghijk')",[outputHash]);await q("UPDATE factory_releases SET state='uncertain',video_id=NULL,error='lost response' WHERE id=$1",[id]);
    const restored=await post('/api/factory/releases/'+id+'/resolve-upload',{target:'video',action:'reconcile'});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().videoId,'abcdefghijk');assert.equal(((await q('SELECT state FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string}).state,'private');
    const rerouted=await post('/api/factory/releases/'+id+'/resolve-upload',{target:'video',action:'reroute',confirmation:'WRONG_CHANNEL'});assert.equal(rerouted.statusCode,200,rerouted.body);assert.equal(rerouted.json().wrongChannelCleared,true);assert.equal(((await q('SELECT state FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string}).state,'review');assert.equal((await q('SELECT state FROM youtube_uploads WHERE file_hash=$1',[outputHash])).rows.length,0);
    await q("INSERT INTO youtube_uploads(file_hash,state) VALUES($1,'uncertain')",[outputHash]);
    await q("UPDATE youtube_uploads SET state='uncertain',video_id=NULL WHERE file_hash=$1",[outputHash]);await q("UPDATE factory_releases SET state='uncertain',video_id=NULL,error='lost response' WHERE id=$1",[id]);
    const resetUpload=await post('/api/factory/releases/'+id+'/resolve-upload',{target:'video',action:'reset',confirmation:'NOT_ON_YOUTUBE'});assert.equal(resetUpload.statusCode,200,resetUpload.body);assert.equal(((await q('SELECT state FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string}).state,'review');await q("UPDATE factory_releases SET state='private',video_id='abcdefghijk' WHERE id=$1",[id]);
    const generatedBeforePlan=generated,shortPlan=await post('/api/factory/releases/'+id+'/shorts-plan',{});assert.equal(shortPlan.statusCode,200,shortPlan.body);assert.equal(shortPlan.json().plan.scenes.length,3);assert.equal(generated,generatedBeforePlan);
    const plannedRow=(await q('SELECT short_plan FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_plan:{hook:string;scenes:unknown[]}};assert.ok(plannedRow.short_plan.hook);assert.equal(plannedRow.short_plan.scenes.length,3);assert.equal((await q('SELECT * FROM factory_short_scenes WHERE release_id=$1',[id])).rows.length,3);
    const shortsStart=await post('/api/factory/releases/'+id+'/shorts',{});assert.equal(shortsStart.statusCode,202,shortsStart.body);
    for(let i=0;i<100;i++){const row=(await q('SELECT short_state,short_output_id FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_state:string;short_output_id:string};if(row.short_state==='review'){assert.equal((await app.inject('/api/factory/assets/'+row.short_output_id+'/file')).statusCode,200);const poster=await app.inject('/api/factory/releases/'+id+'/shorts-poster');assert.equal(poster.statusCode,200);assert.equal((await sharp(poster.rawPayload).metadata()).height,1280);break;}if(i===99)assert.fail('Expected Shorts review state');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(renderFormats.at(-1),'shorts');assert.equal(renderSceneCounts.at(-1),3);assert.deepEqual(imageFormats.slice(-3),['portrait','portrait','portrait']);
    const shortRow=(await q('SELECT short_cover_id,short_plan FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_cover_id:string|null;short_plan:unknown};assert.ok(shortRow.short_cover_id);assert.ok(shortRow.short_plan);
    const generatedBefore=generated,regenerate=await post('/api/factory/releases/'+id+'/shorts',{regenerate:true});assert.equal(regenerate.statusCode,202,regenerate.body);
    for(let i=0;i<100;i++){const row=(await q('SELECT short_state FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_state:string};if(row.short_state==='review')break;if(i===99)assert.fail('Expected regenerated Shorts review state');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(generated,generatedBefore+3);assert.deepEqual(imageFormats.slice(-3),['portrait','portrait','portrait']);
    assert.equal((await post('/api/factory/releases/'+id+'/publish-short',{children:'no',synthetic:'yes',rights:false})).statusCode,400);assert.equal(published,1);
    const shortPublish=await post('/api/factory/releases/'+id+'/publish-short',{children:'no',synthetic:'yes',rights:true});assert.equal(shortPublish.statusCode,200,shortPublish.body);assert.equal(published,2);assert.equal(shortPublish.json().videoId,'abcdefghijk');
    const shortPublished=(await q('SELECT short_publish_state,short_video_id FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_publish_state:string;short_video_id:string};assert.equal(shortPublished.short_publish_state,'private');assert.equal(shortPublished.short_video_id,'abcdefghijk');
    const shortOutput=(await q('SELECT a.object_key FROM factory_releases r JOIN factory_assets a ON a.id=r.short_output_id WHERE r.id=$1',[id])).rows[0] as {object_key:string},shortHash=createHash('sha256').update(objects.get(shortOutput.object_key)!).digest('hex');
    await q("INSERT INTO youtube_uploads(file_hash,state,video_id) VALUES($1,'complete','shorts00001')",[shortHash]);await q("UPDATE factory_releases SET state='uncertain',short_publish_state='uncertain',short_video_id=NULL WHERE id=$1",[id]);
    const restoredShort=await post('/api/factory/releases/'+id+'/resolve-upload',{target:'shorts',action:'reconcile'});assert.equal(restoredShort.statusCode,200,restoredShort.body);assert.equal(restoredShort.json().videoId,'shorts00001');const restoredShortRow=(await q('SELECT state,short_publish_state FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string;short_publish_state:string};assert.equal(restoredShortRow.state,'uncertain');assert.equal(restoredShortRow.short_publish_state,'private');await q("UPDATE factory_releases SET state='private' WHERE id=$1",[id]);
    assert.equal((await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:true})).statusCode,409);assert.equal(published,2);
    const reconcileIdeaId=randomUUID(),reconcileSong={title:release.title,concept:'A keeper returns to the northern castle and completes an old promise before winter.',lyrics:'[Verse 1]\n'+('The northern road remembers every name\n'.repeat(12))+'[Chorus]\n'+('We carry home the flame again\n'.repeat(8)),sunoPrompt:'Epic Viking anthem with a low male lead, controlled choir, frame drums and bowed strings.',artworkPrompt:'Two original adult Vikings beside a northern castle, cinematic realism, no text or logos.'};
    await q("INSERT INTO factory_song_ideas(id,channel_id,mode,brief,state,content,approved_at) VALUES($1,'veil-of-ages','viking-anthem','Reconcile test','approved',$2,NOW())",[reconcileIdeaId,JSON.stringify(reconcileSong)]);
    const reconciled=await uploadIdea(mp3,'Castle.mp3',reconcileIdeaId);assert.equal(reconciled.statusCode,200,reconciled.body);assert.equal(reconciled.json().alreadyReleased,true);assert.equal(reconciled.json().releaseId,id);assert.equal(((await q('SELECT audio_id FROM factory_song_ideas WHERE id=$1',[reconcileIdeaId])).rows[0] as {audio_id:string}).audio_id,audio.json().id);assert.equal(((await q('SELECT recipe FROM factory_releases WHERE id=$1',[id])).rows[0] as {recipe:{ideaId:string}}).recipe.ideaId,reconcileIdeaId);
    const removed=await post('/api/factory/releases/'+id+'/delete',{confirmation:'DELETE'});assert.equal(removed.statusCode,200,removed.body);assert.equal((await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows.length,0);assert.equal((await q("SELECT * FROM factory_assets WHERE kind='audio' AND id=$1",[audio.json().id])).rows.length,1);assert.equal(deletes,6);
    assert.equal((await post('/api/factory/assets/'+audio.json().id+'/delete',{confirmation:'DELETE'})).statusCode,200);assert.equal(deletes,7);
    const ideaId=randomUUID(),song={title:'Oath Beneath the Mountain',concept:'Two siblings return from exile and answer the call of their mountain home.',lyrics:'[Verse 1]\n'+('We carry the winter road beneath our feet\n'.repeat(12))+'[Chorus]\n'+('The mountain calls us home again\n'.repeat(8)),sunoPrompt:'Nordic cinematic hip-hop, low male rap verses, melodic female chorus, frame drums and bowed strings.',artworkPrompt:'Two original adult Vikings overlooking a stormy Nordic fjord, forest green and muted gold, cinematic realism, no text.'};
    await q("INSERT INTO factory_song_ideas(id,channel_id,mode,brief,state,content,approved_at) VALUES($1,'veil-of-ages','viking-rap-duet','Linked test','approved',$2,NOW())",[ideaId,JSON.stringify(song)]);
    const ideaUpload=await uploadIdea(Buffer.from('ID3-linked-approved-song-audio'),'download.mp3',ideaId,'Old browser description '.repeat(30));assert.equal(ideaUpload.statusCode,201,ideaUpload.body);
    const ideaAsset=(await q('SELECT * FROM factory_assets WHERE id=$1',[ideaUpload.json().id])).rows[0] as {name:string;vocal:string;container_id:string};assert.equal(ideaAsset.name,'Oath Beneath the Mountain.mp3');assert.equal(ideaAsset.vocal,'choir');assert.equal(ideaAsset.container_id,'viking-rap-duet');
    const linkedBefore=(await q('SELECT audio_id FROM factory_song_ideas WHERE id=$1',[ideaId])).rows[0] as {audio_id:string|null};
    assert.equal(linkedBefore.audio_id,ideaUpload.json().id);
    assert.equal((await post('/api/factory/assets/'+ideaUpload.json().id+'/delete',{confirmation:'DELETE'})).statusCode,200);
    const linkedAfter=(await q('SELECT audio_id FROM factory_song_ideas WHERE id=$1',[ideaId])).rows[0] as {audio_id:string|null};
    assert.equal(linkedAfter.audio_id,null);
    const dismissed=await post('/api/factory/ideas/'+ideaId+'/dismiss',{});assert.equal(dismissed.statusCode,200,dismissed.body);assert.ok(!(await app.inject('/api/factory')).json().ideas.some((item:{id:string})=>item.id===ideaId));
    failPut=true;const failed=await upload('audio',Buffer.from('ID3-another-test-audio-more-bytes'),'Other.mp3');assert.equal(failed.statusCode,503);assert.ok(!failed.body.includes('secret'));
    assert.ok((await app.inject('/api/factory/storage')).json().reserved>0);
    failPut=false;const recovered=await upload('audio',Buffer.from('ID3-another-test-audio-more-bytes'),'Other.mp3');assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().recovered,true);
  }finally{await app.close();pool!.query=originalQuery;pool!.connect=originalConnect;await db.close();await pool!.end();}
});
