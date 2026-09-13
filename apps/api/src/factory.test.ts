import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const { buildReleaseConcept }=await import('./factory-ai.js');
const { factorySongMigration }=await import('./factory-song.js');
const { buildYoutubeThumbnail,buildShortsArtwork }=await import('./factory-thumbnail.js');
const { factoryRoutes }=await import('./factory.js');

test('factory browser script parses and storage fails closed without configuration',()=>{
  new Script(factoryScript);
  assert.match(factoryScript,/video\.poster=thumbnailUrl/);
  assert.match(factoryScript,/Повторити встановлення обкладинки/);
  assert.match(factoryScript,/Створити Shorts на 30 секунд/);
  assert.match(factoryScript,/form\.hidden=!!active/);
  assert.match(factoryScript,/Копіювати назву/);
  assert.match(factoryScript,/Монтувати відео/);
  assert.match(factoryScript,/busy=false;await load\(\);await usage\(\)/);
  assert.doesNotMatch(factoryScript,/function ideas\(\)/);
  assert.match(factoryScript,/Скасувати процес/);
  assert.match(factoryScript,/ideas\.some\(idea=>idea\.state==='generating'\)/);
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
});

test('factory: durable library, quotas, duplicates, reservation, retry, review and private upload',async()=>{
  const db=new PGlite();const originalQuery=pool!.query,originalConnect=pool!.connect;
  const q=async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};};
  pool!.query=q as typeof originalQuery;
  let tail=Promise.resolve();pool!.connect=(async()=>{const before=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);await before;return {query:q,release};}) as typeof originalConnect;
  const objects=new Map<string,Buffer>();let otherBytes=0,puts=0,deletes=0,failPut=false,renderFail=true,renders=0,generated=0;const renderPresets:string[]=[],renderSceneCounts:number[]=[],renderFormats:string[]=[];
  const storage:ObjectStore={usage:async()=>otherBytes+[...objects.values()].reduce((n,b)=>n+b.length,0),put:async(k,b)=>{puts++;if(failPut)throw Error('secret never leak');objects.set(k,b);},get:async(k,max)=>{const b=objects.get(k);if(!b||b.length>max)throw Error('not found');return b;},delete:async k=>{deletes++;objects.delete(k);}};
  const app=Fastify();let authorized=true;
  app.decorateRequest('ownerSession',undefined);app.addHook('onRequest',async req=>{if(authorized)req.ownerSession={token_hash:'test',google_sub:'test',verified:true,enrollment_encrypted:null};});
  app.addContentTypeParser('video/mp4',{parseAs:'buffer'},(_req,b,done)=>done(null,b));
  app.addContentTypeParser('image/jpeg',{parseAs:'buffer'},(_req,b,done)=>done(null,b));
  let published=0,thumbnails=0,rejectThumbnail=true;app.post('/youtube/upload',async req=>{published++;assert.equal((req.query as {children:string}).children,'no');return {videoId:'abcdefghijk'};});
  app.post('/youtube/thumbnail',async(_req,reply)=>{thumbnails++;return rejectThumbnail?reply.code(409).send({error:'YouTube ще не підтвердив обкладинку.'}):{ok:true};});
  await app.register(factoryRoutes,{storage,probe:async()=>120,imageGenerator:async()=>{generated++;return {data:Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#31513a"/></svg>'),type:'image/png'};},render:async(images:string|string[],_audio:string,out:string,_kind:string,_signal?:AbortSignal,format?:'video'|'shorts',preset?:string,onProgress?:(p:{percent:number;seconds:number;duration:number})=>void)=>{renders++;renderFormats.push(format||'video');renderSceneCounts.push(Array.isArray(images)?images.length:1);if(preset)renderPresets.push(preset);onProgress?.({percent:50,seconds:60,duration:120});if(renderFail)throw Error('test render interruption');await writeFile(out,Buffer.from('0000ftypisom-fake-render-test'));}});
  const headers={origin:'https://api.example.test'};
  const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers,payload});
  const upload=(kind:string,body:Buffer,name:string)=>app.inject({method:'POST',url:'/api/factory/assets?kind='+kind+'&vocal=instrumental',headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="'+name+'"\r\nContent-Type: application/octet-stream\r\n\r\n'),body,Buffer.from('\r\n--testboundary--\r\n')])});
  const uploadIdea=(body:Buffer,name:string,ideaId:string)=>app.inject({method:'POST',url:'/api/factory/assets?kind=audio&ideaId='+ideaId,headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="'+name+'"\r\nContent-Type: application/octet-stream\r\n\r\n'),body,Buffer.from('\r\n--testboundary--\r\n')])});
  const waitState=async(id:string,state:string)=>{for(let i=0;i<100;i++){const r=(await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string};if(r.state===state)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected '+state);};
  try{
    await db.exec(factoryMigration);await db.exec(factorySongMigration);
    authorized=false;assert.equal((await app.inject('/api/factory')).statusCode,401);authorized=true;
    assert.equal((await app.inject({method:'POST',url:'/api/factory/recipe',headers:{origin:'https://evil.test'},payload:{}})).statusCode,403);
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
    const release=(await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows[0] as {track_id:string;output_id:string;progress:number;stage:string;recipe:{coverMode:string;prompt:string;motionIntensity:string;productionPlan:{version:number;source:string;sceneCount:number;effects:string[]}}};assert.equal(release.track_id,audio.json().id);assert.equal(release.recipe.coverMode,'ai');assert.match(release.recipe.prompt,/Viking/);assert.equal(release.recipe.motionIntensity,'cinematic');assert.equal(release.recipe.productionPlan.version,2);assert.equal(release.recipe.productionPlan.sceneCount,1);assert.equal(release.recipe.productionPlan.source,'baseline-rules');assert.ok(!release.recipe.productionPlan.effects.includes('story.three-scenes'));assert.ok(!release.recipe.productionPlan.effects.includes('camera.center-push'));assert.equal(release.progress,100);assert.equal(release.stage,'complete');
    assert.equal((await app.inject('/api/factory/assets/'+release.output_id+'/file')).statusCode,200);
    assert.equal((await post('/api/factory/assets/'+release.output_id+'/delete',{confirmation:'DELETE'})).statusCode,409);
    authorized=false;assert.equal((await app.inject('/api/factory/assets/'+release.output_id+'/file')).statusCode,401);authorized=true;
    assert.equal((await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:false})).statusCode,400);assert.equal(published,0);
    const publish=await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:true});assert.equal(publish.statusCode,200,publish.body);assert.equal(published,1);assert.equal(publish.json().thumbnailSet,false);assert.equal(thumbnails,1,publish.body);
    rejectThumbnail=false;const thumbnailRetry=await post('/api/factory/releases/'+id+'/thumbnail',{});assert.equal(thumbnailRetry.statusCode,200,thumbnailRetry.body);assert.equal(thumbnailRetry.json().thumbnailSet,true);assert.equal(thumbnails,2);assert.equal(((await q('SELECT error FROM factory_releases WHERE id=$1',[id])).rows[0] as {error:string|null}).error,null);
    const shortsStart=await post('/api/factory/releases/'+id+'/shorts',{});assert.equal(shortsStart.statusCode,202,shortsStart.body);
    for(let i=0;i<100;i++){const row=(await q('SELECT short_state,short_output_id FROM factory_releases WHERE id=$1',[id])).rows[0] as {short_state:string;short_output_id:string};if(row.short_state==='review'){assert.equal((await app.inject('/api/factory/assets/'+row.short_output_id+'/file')).statusCode,200);const poster=await app.inject('/api/factory/releases/'+id+'/shorts-poster');assert.equal(poster.statusCode,200);assert.equal((await sharp(poster.rawPayload).metadata()).height,1280);break;}if(i===99)assert.fail('Expected Shorts review state');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(renderFormats.at(-1),'shorts');assert.equal(renderSceneCounts.at(-1),1);
    assert.equal((await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:true})).statusCode,409);assert.equal(published,1);
    const removed=await post('/api/factory/releases/'+id+'/delete',{confirmation:'DELETE'});assert.equal(removed.statusCode,200,removed.body);assert.equal((await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows.length,0);assert.equal((await q("SELECT * FROM factory_assets WHERE kind='audio' AND id=$1",[audio.json().id])).rows.length,1);assert.equal(deletes,3);
    assert.equal((await post('/api/factory/assets/'+audio.json().id+'/delete',{confirmation:'DELETE'})).statusCode,200);assert.equal(deletes,4);
    const ideaId=randomUUID(),song={title:'Oath Beneath the Mountain',concept:'Two siblings return from exile and answer the call of their mountain home.',lyrics:'[Verse 1]\n'+('We carry the winter road beneath our feet\n'.repeat(12))+'[Chorus]\n'+('The mountain calls us home again\n'.repeat(8)),sunoPrompt:'Nordic cinematic hip-hop, low male rap verses, melodic female chorus, frame drums and bowed strings.',artworkPrompt:'Two original adult Vikings overlooking a stormy Nordic fjord, forest green and muted gold, cinematic realism, no text.'};
    await q("INSERT INTO factory_song_ideas(id,channel_id,mode,brief,state,content,approved_at) VALUES($1,'veil-of-ages','viking-rap-duet','Linked test','approved',$2,NOW())",[ideaId,JSON.stringify(song)]);
    const ideaUpload=await uploadIdea(Buffer.from('ID3-linked-approved-song-audio'),'download.mp3',ideaId);assert.equal(ideaUpload.statusCode,201,ideaUpload.body);
    const ideaAsset=(await q('SELECT * FROM factory_assets WHERE id=$1',[ideaUpload.json().id])).rows[0] as {name:string;vocal:string;container_id:string};assert.equal(ideaAsset.name,'Oath Beneath the Mountain.mp3');assert.equal(ideaAsset.vocal,'choir');assert.equal(ideaAsset.container_id,'viking-rap-duet');
    const linkedBefore=(await q('SELECT audio_id FROM factory_song_ideas WHERE id=$1',[ideaId])).rows[0] as {audio_id:string|null};
    assert.equal(linkedBefore.audio_id,ideaUpload.json().id);
    assert.equal((await post('/api/factory/assets/'+ideaUpload.json().id+'/delete',{confirmation:'DELETE'})).statusCode,200);
    const linkedAfter=(await q('SELECT audio_id FROM factory_song_ideas WHERE id=$1',[ideaId])).rows[0] as {audio_id:string|null};
    assert.equal(linkedAfter.audio_id,null);
    failPut=true;const failed=await upload('audio',Buffer.from('ID3-another-test-audio-more-bytes'),'Other.mp3');assert.equal(failed.statusCode,503);assert.ok(!failed.body.includes('secret'));
    assert.ok((await app.inject('/api/factory/storage')).json().reserved>0);
    failPut=false;assert.equal((await upload('audio',Buffer.from('ID3-another-test-audio-more-bytes'),'Other.mp3')).statusCode,409);
  }finally{await app.close();pool!.query=originalQuery;pool!.connect=originalConnect;await db.close();await pool!.end();}
});
