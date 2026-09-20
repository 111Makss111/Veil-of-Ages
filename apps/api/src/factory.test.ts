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
const { buildReleaseConcept,buildShortsConcept,buildShortsStoryPlan,buildOpenAIShortsStoryRequest }=await import('./factory-ai.js');
const { factorySongMigration }=await import('./factory-song.js');
const { buildYoutubeThumbnail,buildShortsArtwork,buildShortsStoryArtwork,buildKineticLyricOverlay,buildVideoLyricFrame }=await import('./factory-thumbnail.js');
const { buildManualShortsLyrics,buildShortsLyricCues,selectShortsLyrics }=await import('./shorts-lyrics.js');
const { buildVideoLyricCues,buildWhisperLyricsPrompt }=await import('./video-lyrics.js');
const { factoryRoutes }=await import('./factory.js');
const { localWorkerRoutes }=await import('./local-worker-api.js');

test('factory browser script parses and storage fails closed without configuration',()=>{
  new Script(factoryScript);
  assert.match(factoryScript,/video\.poster=thumbnailUrl/);
  assert.match(factoryScript,/Повторити встановлення обкладинки/);
  assert.match(factoryScript,/function conveyorShortsWorkspace/);
  assert.match(factoryScript,/function shortPlanView/);
  assert.match(factoryScript,/ШІ переглядає кадри/);
  assert.doesNotMatch(factoryScript,/Картинки не генеруються/);
  assert.match(factoryScript,/input\.multiple=true/);
  assert.match(factoryScript,/shorts-arrange/);
  assert.match(factoryScript,/shorts-manual/);
  assert.match(factoryScript,/Показати 6 компактних відеопромптів/);
  assert.match(factoryScript,/Підготувати 6 промптів/);
  assert.match(factoryScript,/Порядок назв неважливий/);
  assert.match(factoryScript,/Взяти поточний час/);
  assert.match(factoryScript,/chorusStart:timing\.value\(\)/);
  assert.doesNotMatch(factoryScript,/Потрібне підключення OpenAI для точної синхронізації/);
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
  assert.match(factoryScript,/function conveyorShortsWorkspace/);
  assert.match(factoryScript,/shortsClipMatchingConfigured/);
  assert.match(factoryScript,/factory-shorts-release/);
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

test('full lyric video groups frequent phrases and highlights chorus lines',async()=>{
  const words='We carry fire through the night We carry fire through the night'.split(' ').map((word,index)=>({word,start:index*.42,end:index*.42+.32}));
  const cues=buildVideoLyricCues(words,30,'[Chorus — Duet]\nWe carry fire through the night');
  assert.ok(cues.length>=2);assert.ok(cues.some(cue=>cue.emphasis==='chorus'));assert.ok(cues.every(cue=>cue.end>cue.start&&cue.text.length>0));
  const frame=await buildVideoLyricFrame(cues[0]!,0,'hold'),meta=await sharp(frame).metadata();assert.equal(meta.width,1280);assert.equal(meta.height,720);assert.equal(meta.format,'png');
});

test('Whisper receives a compact keyword prompt instead of the full song',()=>{
  const lyrics='[Verse 1]\n'+('The northern fire remembers Eirik beside the mountain road\n'.repeat(120));
  const prompt=buildWhisperLyricsPrompt(lyrics);
  assert.ok(prompt.length>0&&prompt.length<=700);assert.ok(prompt.split(', ').length<=80);assert.doesNotMatch(prompt,/\[Verse/);
  assert.equal((prompt.match(/Eirik/gi)||[]).length,1);
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

test('factory creates a reviewable six-scene Shorts micro-story',()=>{
  const plan=buildShortsStoryPlan('release-1','Gold Beneath the Snow',{youtubeDescription:'Two travelers return to a winter fjord after a broken oath. #Shorts'});
  assert.equal(plan.format,'story');assert.equal(plan.scenes.length,6);assert.ok(plan.hook.length<=96);
  assert.equal(plan.source,'concept-fallback');assert.match(plan.sourceNote,/Слів пісні не знайдено/);
  assert.equal(plan.kineticText.mode,'pending');assert.deepEqual(plan.kineticText.cues,[]);
  assert.deepEqual(plan.scenes.map(scene=>scene.label),['Гачок','Загроза','Вибір','Перехід','Наслідок','Кульмінація']);
  assert.equal(new Set(plan.scenes.map(scene=>scene.hash)).size,6);
  for(const scene of plan.scenes){assert.match(scene.prompt,/VERTICAL 9:16 COMPOSITION/);assert.match(scene.prompt,/Character continuity anchor/);}
});

test('Shorts story director receives full lyrics and an exact six-scene continuity contract',()=>{
  const lyrics='[Verse 1 — Male] The harbor bell was buried in the snow.\n[Chorus — Duet] Carry the ember home through the storm.'.repeat(12);
  const request=buildOpenAIShortsStoryRequest('Embers Across the Fjord','Two exiles cross the winter pass.',lyrics,'test-model') as any;
  const prompt=request.input[1].content[0].text as string;
  assert.equal(request.model,'test-model');assert.equal(request.text.format.schema.properties.scenes.minItems,6);assert.equal(request.text.format.schema.properties.scenes.maxItems,6);
  assert.match(prompt,/exactly six consecutive 5-second clips/);assert.match(prompt,/especially the chorus/);assert.match(prompt,/same adult man and woman/);assert.match(prompt,/harbor bell was buried/);
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
  const kinetic=await buildKineticLyricOverlay('We carry the northern fire','fire',1),kineticMetadata=await sharp(kinetic).metadata();assert.equal(kineticMetadata.width,680);assert.equal(kineticMetadata.height,300);assert.equal(kineticMetadata.format,'png');
});

test('factory groups timestamped vocal words into bounded kinetic phrases',()=>{
  const cues=buildShortsLyricCues([
    {word:'Stand',start:.2,end:.55},{word:'my',start:.58,end:.75},{word:'ground',start:.78,end:1.2},
    {word:'when',start:1.8,end:2.05},{word:'the',start:2.08,end:2.2},{word:'wolves',start:2.22,end:2.7},{word:'attack',start:2.72,end:3.1}
  ]);
  assert.equal(cues.length,2);assert.equal(cues[0]?.text,'Stand my ground');assert.equal(cues[0]?.accent,'GROUND');assert.equal(cues[1]?.accent,'WOLVES');
  const aligned=selectShortsLyrics([
    {word:'Stand',start:40,end:40.5},{word:'my',start:40.6,end:40.8},{word:'ground',start:40.9,end:41.4},
    {word:'when',start:41.5,end:41.8},{word:'the',start:41.9,end:42},{word:'wolves',start:42.1,end:42.6},{word:'attack',start:42.7,end:43.2}
  ],'[Chorus]\nStand my ground when the wolves attack',120);
  assert.equal(aligned?.section,'chorus');assert.equal(aligned?.cues[0]?.text,'Stand my ground when');assert.equal(aligned?.cues[1]?.text,'the wolves attack');assert.ok((aligned?.clipStart||0)>0);
  const manual=buildManualShortsLyrics('[Verse]\nCold road\n[Chorus]\nStand my ground\nWhen the wolves attack\nCarry the fire\nWe are coming back',120,46.5);
  assert.equal(manual?.clipStart,46.5);assert.equal(manual?.clipDuration,30);assert.equal(manual?.section,'chorus');assert.equal(manual?.cues.length,4);assert.equal(manual?.cues[0]?.text,'Stand my ground');assert.equal(manual?.cues.at(-1)?.end,30);
});

test('factory: durable library, quotas, duplicates, reservation, retry, review and private upload',async()=>{
  const db=new PGlite();const originalQuery=pool!.query,originalConnect=pool!.connect;
  const q=async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};};
  pool!.query=q as typeof originalQuery;
  let tail=Promise.resolve();pool!.connect=(async()=>{const before=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);await before;return {query:q,release};}) as typeof originalConnect;
  const objects=new Map<string,Buffer>();let otherBytes=0,puts=0,deletes=0,failPut=false,renderFail=true,renders=0,generated=0;const renderPresets:string[]=[],renderSceneCounts:number[]=[],renderFormats:string[]=[],imageFormats:string[]=[],lyricOverlayCounts:number[]=[];
  const storage:ObjectStore={usage:async()=>otherBytes+[...objects.values()].reduce((n,b)=>n+b.length,0),put:async(k,b)=>{puts++;if(failPut)throw Error('secret never leak');objects.set(k,b);},get:async(k,max)=>{const b=objects.get(k);if(!b||b.length>max)throw Error('not found');return b;},signedGet:async k=>'https://r2.example.test/get/'+encodeURIComponent(k),signedPut:async k=>'https://r2.example.test/put/'+encodeURIComponent(k),head:async k=>{const b=objects.get(k);if(!b)throw Error('not found');return {bytes:b.length,type:'video/mp4'};},delete:async k=>{deletes++;objects.delete(k);}};
  const app=Fastify();let authorized=true;
  app.decorateRequest('ownerSession',undefined);app.addHook('onRequest',async req=>{if(authorized)req.ownerSession={token_hash:'test',google_sub:'test',verified:true,enrollment_encrypted:null};});
  app.addContentTypeParser('video/mp4',{parseAs:'buffer'},(_req,b,done)=>done(null,b));
  app.addContentTypeParser('image/jpeg',{parseAs:'buffer'},(_req,b,done)=>done(null,b));
  let published=0,thumbnails=0,rejectThumbnail=true;app.post('/youtube/upload',async req=>{published++;assert.equal((req.query as {children:string}).children,'no');return {videoId:'abcdefghijk'};});
  app.post('/youtube/thumbnail',async(_req,reply)=>{thumbnails++;return rejectThumbnail?reply.code(409).send({error:'YouTube ще не підтвердив обкладинку.'}):{ok:true};});
  await app.register(localWorkerRoutes,{storage});
  await app.register(factoryRoutes,{storage,probe:async(_file:string,kind:string)=>kind==='mp4'?5:120,lyricTranscriber:async()=>({clipStart:45,clipDuration:30,section:'chorus',cues:[{start:.2,end:2,text:'We carry home',accent:'CARRY'},{start:2.1,end:4,text:'the flame again',accent:'FLAME'}]}),clipOrderer:async()=>[5,4,3,2,1,0],clipFrameExtractor:async()=>Buffer.from('representative-frame'),publisher:async(_path:string,metadata:{children:'yes'|'no'})=>{published++;assert.equal(metadata.children,'no');return {videoId:'abcdefghijk',duplicate:false};},imageGenerator:async(_prompt:string,_seed:number,_signal?:AbortSignal,imageOptions?:{format?:'landscape'|'portrait'})=>{generated++;imageFormats.push(imageOptions?.format||'landscape');return {data:Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#31513a"/></svg>'),type:'image/png'};},render:async(images:string|string[],_audio:string,out:string,_kind:string,_signal?:AbortSignal,format?:'video'|'shorts',preset?:string,onProgress?:(p:{percent:number;seconds:number;duration:number})=>void,_intensity?:string,_effects?:readonly string[],lyricOverlays?:ReadonlyArray<{path:string;start:number;end:number}>)=>{renders++;renderFormats.push(format||'video');renderSceneCounts.push(Array.isArray(images)?images.length:1);lyricOverlayCounts.push(lyricOverlays?.length||0);if(preset)renderPresets.push(preset);onProgress?.({percent:50,seconds:60,duration:120});if(renderFail)throw Error('test render interruption');await writeFile(out,Buffer.from('0000ftypisom-fake-render-test'));},renderClips:async(clips:string[],_durations:number[],_audio:string,out:string,_kind:string,_signal?:AbortSignal,onProgress?:(p:{percent:number;seconds:number;duration:number})=>void,lyricOverlays?:ReadonlyArray<{path:string;start:number;end:number}>)=>{renderFormats.push('shorts');renderSceneCounts.push(clips.length);lyricOverlayCounts.push(lyricOverlays?.length||0);onProgress?.({percent:100,seconds:30,duration:30});await writeFile(out,Buffer.from('0000ftypisom-fake-manual-shorts'));}});
  const headers={origin:'https://api.example.test'};
  const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers,payload});
  const upload=(kind:string,body:Buffer,name:string)=>app.inject({method:'POST',url:'/api/factory/assets?kind='+kind+'&vocal=instrumental',headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="'+name+'"\r\nContent-Type: application/octet-stream\r\n\r\n'),body,Buffer.from('\r\n--testboundary--\r\n')])});
  const uploadIdea=(body:Buffer,name:string,ideaId:string,theme='')=>app.inject({method:'POST',url:'/api/factory/assets?kind=audio&ideaId='+ideaId+'&theme='+encodeURIComponent(theme),headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="'+name+'"\r\nContent-Type: application/octet-stream\r\n\r\n'),body,Buffer.from('\r\n--testboundary--\r\n')])});
  const waitState=async(id:string,state:string)=>{for(let i=0;i<100;i++){const r=(await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string};if(r.state===state)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected '+state);};
  const waitShortState=async(id:string,state:string)=>{for(let i=0;i<100;i++){const r=(await q('SELECT short_state FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_state:string};if(r.short_state===state)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected Shorts '+state);};
  try{
    await db.exec(factoryMigration);await db.exec(factorySongMigration);await db.exec("CREATE TABLE youtube_uploads(file_hash TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('uploading','complete','uncertain')),video_id TEXT)");
    authorized=false;assert.equal((await app.inject('/api/factory')).statusCode,401);authorized=true;
    const factoryHtml=await app.inject('/factory');assert.match(factoryHtml.body,/\/factory\/icon\.svg/);assert.match(factoryHtml.body,/Тіллі Сміт: урок, що врятував пляж/);assert.match(factoryHtml.body,/id="shortsWorkspace"/);assert.doesNotMatch(factoryHtml.body,/href="#shorts-lab"/);assert.doesNotMatch(factoryHtml.body,/id="clipForm"/);assert.match(factoryHtml.body,/id="noteForm"/);const favicon=await app.inject('/factory/icon.svg');assert.equal(favicon.statusCode,200);assert.match(favicon.headers['content-type']||'',/image\/svg\+xml/);assert.match(favicon.body,/bde998/);
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
    const shortsIdeaId=randomUUID(),shortsSong={title:release.title,concept:'Two keepers return through the winter pass.',lyrics:'[Verse 1]\n'+('The northern road remembers every name\n'.repeat(8))+'[Chorus]\n'+('We carry home the flame again\n'.repeat(8)),sunoPrompt:'Epic Viking anthem.',artworkPrompt:'Two original adult Vikings in a winter pass.'};
    await q("INSERT INTO factory_song_ideas(id,channel_id,mode,brief,state,content,approved_at,audio_id) VALUES($1,'veil-of-ages','viking-anthem','Shorts test','approved',$2,NOW(),$3)",[shortsIdeaId,JSON.stringify(shortsSong),audio.json().id]);await q("UPDATE factory_releases SET recipe=jsonb_set(recipe,'{ideaId}',to_jsonb($2::text),true) WHERE id=$1",[id,shortsIdeaId]);
    const generatedBeforePlan=generated,shortPlan=await post('/api/factory/releases/'+id+'/shorts-plan',{});assert.equal(shortPlan.statusCode,200,shortPlan.body);assert.equal(shortPlan.json().plan.scenes.length,6);assert.equal(generated,generatedBeforePlan);
    const plannedRow=(await q('SELECT short_plan FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_plan:{hook:string;scenes:unknown[]}};assert.ok(plannedRow.short_plan.hook);assert.equal(plannedRow.short_plan.scenes.length,6);assert.equal((await q('SELECT * FROM factory_short_scenes WHERE release_id=$1',[id])).rows.length,0);
    const storyboardStart=await post('/api/factory/releases/'+id+'/shorts-storyboard',{});assert.equal(storyboardStart.statusCode,409,storyboardStart.body);assert.match(storyboardStart.json().error,/картинки вимкнено/i);
    const automaticShorts=await post('/api/factory/releases/'+id+'/shorts',{chorusStart:44});assert.equal(automaticShorts.statusCode,202,automaticShorts.body);await waitShortState(id,'review');assert.equal(renderSceneCounts.at(-1),1);assert.ok((lyricOverlayCounts.at(-1)||0)>=2);const timedShort=(await q('SELECT short_plan FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_plan:{kineticText:{mode:string;clipStart:number}}};assert.equal(timedShort.short_plan.kineticText.mode,'manual');assert.equal(timedShort.short_plan.kineticText.clipStart,44);
    for(let position=0;position<6;position++){
      const shortClipPayload=Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="scene-'+(position+1)+'.mp4"\r\nContent-Type: video/mp4\r\n\r\n'),Buffer.from('0000ftypisom-short-scene-'+position),Buffer.from('\r\n--testboundary--\r\n')]);
      const savedClip=await app.inject({method:'POST',url:'/api/factory/releases/'+id+'/shorts-clips?position='+position,headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:shortClipPayload});assert.equal(savedClip.statusCode,201,savedClip.body);
    }
    assert.equal((await q('SELECT * FROM factory_short_clips WHERE release_id=$1',[id])).rows.length,6);assert.equal(generated,generatedBeforePlan);
    const arranged=await post('/api/factory/releases/'+id+'/shorts-arrange',{});assert.equal(arranged.statusCode,200,arranged.body);assert.equal(arranged.json().assignments[0].name,'scene-6.mp4');
    const shortsStart=await post('/api/factory/releases/'+id+'/shorts-manual',{});assert.equal(shortsStart.statusCode,202,shortsStart.body);
    for(let i=0;i<100;i++){const row=(await q('SELECT short_state,short_output_id FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_state:string;short_output_id:string};if(row.short_state==='review'){assert.equal((await app.inject('/api/factory/assets/'+row.short_output_id+'/file')).statusCode,200);const poster=await app.inject('/api/factory/releases/'+id+'/shorts-poster');assert.equal(poster.statusCode,200);assert.equal((await sharp(poster.rawPayload).metadata()).height,1280);break;}if(i===99)assert.fail('Expected Shorts review state');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(renderFormats.at(-1),'shorts');assert.equal(renderSceneCounts.at(-1),6);assert.ok((lyricOverlayCounts.at(-1)||0)>=2);assert.equal(imageFormats.filter(format=>format==='portrait').length,0);
    const shortRow=(await q('SELECT short_cover_id,short_plan FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_cover_id:string|null;short_plan:{mode:string;scenes:unknown[]}};assert.equal(shortRow.short_cover_id,null);assert.equal(shortRow.short_plan.mode,'manual-video');assert.equal(shortRow.short_plan.scenes.length,6);
    assert.equal((await post('/api/factory/releases/'+id+'/publish-short',{children:'no',synthetic:'yes',rights:false})).statusCode,400);assert.equal(published,1);
    const shortPublish=await post('/api/factory/releases/'+id+'/publish-short',{children:'no',synthetic:'yes',rights:true});assert.equal(shortPublish.statusCode,200,shortPublish.body);assert.equal(published,2);assert.equal(shortPublish.json().videoId,'abcdefghijk');
    const shortPublished=(await q('SELECT short_publish_state,short_video_id FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_publish_state:string;short_video_id:string};assert.equal(shortPublished.short_publish_state,'private');assert.equal(shortPublished.short_video_id,'abcdefghijk');
    const shortOutput=(await q('SELECT a.object_key FROM factory_releases r JOIN factory_assets a ON a.id=r.short_output_id WHERE r.id=$1',[id])).rows[0] as {object_key:string},shortHash=createHash('sha256').update(objects.get(shortOutput.object_key)!).digest('hex');
    await q("INSERT INTO youtube_uploads(file_hash,state,video_id) VALUES($1,'complete','shorts00001')",[shortHash]);await q("UPDATE factory_releases SET state='uncertain',short_publish_state='uncertain',short_video_id=NULL WHERE id=$1",[id]);
    const restoredShort=await post('/api/factory/releases/'+id+'/resolve-upload',{target:'shorts',action:'reconcile'});assert.equal(restoredShort.statusCode,200,restoredShort.body);assert.equal(restoredShort.json().videoId,'shorts00001');const restoredShortRow=(await q('SELECT state,short_publish_state FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string;short_publish_state:string};assert.equal(restoredShortRow.state,'uncertain');assert.equal(restoredShortRow.short_publish_state,'private');await q("UPDATE factory_releases SET state='private' WHERE id=$1",[id]);
    assert.equal((await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:true})).statusCode,409);assert.equal(published,2);
    const reconcileIdeaId=randomUUID(),reconcileSong={title:release.title,concept:'A keeper returns to the northern castle and completes an old promise before winter.',lyrics:'[Verse 1]\n'+('The northern road remembers every name\n'.repeat(12))+'[Chorus]\n'+('We carry home the flame again\n'.repeat(8)),sunoPrompt:'Epic Viking anthem with a low male lead, controlled choir, frame drums and bowed strings.',artworkPrompt:'Two original adult Vikings beside a northern castle, cinematic realism, no text or logos.'};
    await q('UPDATE factory_song_ideas SET audio_id=NULL WHERE id=$1',[shortsIdeaId]);await q("UPDATE factory_releases SET recipe=recipe-'ideaId' WHERE id=$1",[id]);await q("INSERT INTO factory_song_ideas(id,channel_id,mode,brief,state,content,approved_at) VALUES($1,'veil-of-ages','viking-anthem','Reconcile test','approved',$2,NOW())",[reconcileIdeaId,JSON.stringify(reconcileSong)]);
    const reconciled=await uploadIdea(mp3,'Castle.mp3',reconcileIdeaId);assert.equal(reconciled.statusCode,200,reconciled.body);assert.equal(reconciled.json().alreadyReleased,true);assert.equal(reconciled.json().releaseId,id);assert.equal(((await q('SELECT audio_id FROM factory_song_ideas WHERE id=$1',[reconcileIdeaId])).rows[0] as {audio_id:string}).audio_id,audio.json().id);assert.equal(((await q('SELECT recipe FROM factory_releases WHERE id=$1',[id])).rows[0] as {recipe:{ideaId:string}}).recipe.ideaId,reconcileIdeaId);
    process.env.LOCAL_WORKER_SECRET='local-worker-test-secret-0123456789abcdef';const workerHeaders={authorization:'Bearer '+process.env.LOCAL_WORKER_SECRET};
    assert.equal((await app.inject({method:'POST',url:'/api/local-worker/heartbeat',payload:{workerId:'test-pc',name:'Test PC',capabilities:{gpu:'test'},busy:false,releaseId:null}})).statusCode,401);
    await q("UPDATE factory_releases SET state='rendering',stage='waiting-local',progress=25 WHERE id=$1",[id]);
    const claim=await app.inject({method:'POST',url:'/api/local-worker/claim',headers:workerHeaders,payload:{workerId:'test-pc',name:'Test PC',capabilities:{gpu:'test'}}});assert.equal(claim.statusCode,200,claim.body);const localJob=claim.json().job;assert.equal(localJob.id,id);assert.match(localJob.audio.url,/r2\.example\.test/);assert.equal(localJob.scenes.length,1);
    const workerProgress=await app.inject({method:'POST',url:'/api/local-worker/jobs/'+id+'/progress',headers:workerHeaders,payload:{lease:localJob.lease,workerId:'test-pc',stage:'local-rendering',progress:70,detail:'Rendering locally',seconds:60,duration:120}});assert.equal(workerProgress.statusCode,200,workerProgress.body);
    objects.set(outputObjectKey,Buffer.alloc(2048));const workerCues=[{start:.2,end:2.1,text:'We carry fire',accent:'FIRE',emphasis:'chorus',position:'center'}];
    const workerComplete=await app.inject({method:'POST',url:'/api/local-worker/jobs/'+id+'/complete',headers:workerHeaders,payload:{lease:localJob.lease,workerId:'test-pc',cues:workerCues}});assert.equal(workerComplete.statusCode,200,workerComplete.body);const locallyCompleted=(await q('SELECT state,recipe FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string;recipe:{lyricVideo:{mode:string;cues:unknown[]}}};assert.equal(locallyCompleted.state,'review');assert.equal(locallyCompleted.recipe.lyricVideo.mode,'transcribed');delete process.env.LOCAL_WORKER_SECRET;
    const removed=await post('/api/factory/releases/'+id+'/delete',{confirmation:'DELETE'});assert.equal(removed.statusCode,200,removed.body);assert.equal((await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows.length,0);assert.equal((await q("SELECT * FROM factory_assets WHERE kind='audio' AND id=$1",[audio.json().id])).rows.length,1);assert.equal(deletes,9);
    assert.equal((await post('/api/factory/assets/'+audio.json().id+'/delete',{confirmation:'DELETE'})).statusCode,200);assert.equal(deletes,10);
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
