import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { factoryScript } from './factory-ui.js';
import { createObjectStore, INPUT_LIMIT, STORAGE_LIMIT, type ObjectStore } from './factory-storage.js';
process.env.DATABASE_URL='postgresql://test:test@localhost/test';
process.env.PUBLIC_API_URL='https://api.example.test';
const { pool }=await import('./db.js');
const { factoryMigration, reserveAsset }=await import('./factory-store.js');
const { factoryRoutes }=await import('./factory.js');

test('factory browser script parses and storage fails closed without configuration',()=>{
  new Script(factoryScript);
  const before=process.env.R2_ACCOUNT_ID;delete process.env.R2_ACCOUNT_ID;
  assert.equal(createObjectStore(),null);
  if(before)process.env.R2_ACCOUNT_ID=before;
});

test('factory: durable library, quotas, duplicates, reservation, retry, review and private upload',async()=>{
  const db=new PGlite();const originalQuery=pool!.query,originalConnect=pool!.connect;
  const q=async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};};
  pool!.query=q as typeof originalQuery;
  let tail=Promise.resolve();pool!.connect=(async()=>{const before=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);await before;return {query:q,release};}) as typeof originalConnect;
  const objects=new Map<string,Buffer>();let otherBytes=0,puts=0,failPut=false,renderFail=true,renders=0;
  const storage:ObjectStore={usage:async()=>otherBytes+[...objects.values()].reduce((n,b)=>n+b.length,0),put:async(k,b)=>{puts++;if(failPut)throw Error('secret never leak');objects.set(k,b);},get:async(k,max)=>{const b=objects.get(k);if(!b||b.length>max)throw Error('not found');return b;}};
  const app=Fastify();let authorized=true;
  app.decorateRequest('ownerSession',undefined);app.addHook('onRequest',async req=>{if(authorized)req.ownerSession={token_hash:'test',google_sub:'test',verified:true,enrollment_encrypted:null};});
  app.addContentTypeParser('video/mp4',{parseAs:'buffer'},(_req,b,done)=>done(null,b));
  let published=0;app.post('/youtube/upload',async req=>{published++;assert.equal((req.query as {children:string}).children,'no');return {videoId:'abcdefghijk'};});
  await app.register(factoryRoutes,{storage,probe:async()=>120,render:async(_image:string,_audio:string,out:string)=>{renders++;if(renderFail)throw Error('test render interruption');await writeFile(out,Buffer.from('0000ftypisom-fake-render-test'));}});
  const headers={origin:'https://api.example.test'};
  const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers,payload});
  const upload=(kind:string,body:Buffer,name:string)=>app.inject({method:'POST',url:'/api/factory/assets?kind='+kind+'&vocal=instrumental',headers:{...headers,'content-type':'multipart/form-data; boundary=testboundary'},payload:Buffer.concat([Buffer.from('--testboundary\r\nContent-Disposition: form-data; name="file"; filename="'+name+'"\r\nContent-Type: application/octet-stream\r\n\r\n'),body,Buffer.from('\r\n--testboundary--\r\n')])});
  const waitState=async(id:string,state:string)=>{for(let i=0;i<100;i++){const r=(await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows[0] as {state:string};if(r.state===state)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected '+state);};
  try{
    await db.exec(factoryMigration);
    authorized=false;assert.equal((await app.inject('/api/factory')).statusCode,401);authorized=true;
    assert.equal((await app.inject({method:'POST',url:'/api/factory/recipe',headers:{origin:'https://evil.test'},payload:{}})).statusCode,403);
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40)]),mp3=Buffer.from('ID3-this-is-an-isolated-test-audio');
    const image=await upload('image',png,'castle.png');assert.equal(image.statusCode,201,image.body);
    const audio=await upload('audio',mp3,'Castle.mp3');assert.equal(audio.statusCode,201,audio.body);
    const duplicate=await upload('audio',mp3,'Different name.mp3');assert.equal(duplicate.json().duplicate,true);assert.equal(puts,2);
    assert.equal((await post('/api/factory/recipe',{vocal:'instrumental',coverId:image.json().id,revision:1})).statusCode,200);
    assert.equal((await post('/api/factory/recipe',{vocal:'choir',coverId:image.json().id,revision:1})).statusCode,409);
    otherBytes=INPUT_LIMIT;
    await assert.rejects(reserveAsset(storage,{kind:'audio',hash:'new',name:'New',bytes:10,type:'audio/mpeg',duration:120,theme:'',vocal:'instrumental'}),/Запас/);
    otherBytes=STORAGE_LIMIT;
    assert.equal((await post('/api/factory/releases',{requestKey:randomUUID()})).statusCode,409);
    assert.equal((await q('SELECT * FROM factory_releases')).rows.length,0);
    otherBytes=0;
    const key=randomUUID(),start=await post('/api/factory/releases',{requestKey:key});assert.equal(start.statusCode,202,start.body);
    const id=start.json().id;assert.equal((await post('/api/factory/releases',{requestKey:key})).json().id,id);
    await waitState(id,'failed');assert.equal(renders,1);
    assert.equal((await post('/api/factory/releases',{requestKey:randomUUID()})).statusCode,409); // Track remains reserved.
    renderFail=false;assert.equal((await post('/api/factory/releases/'+id+'/retry',{})).statusCode,202);
    await waitState(id,'review');assert.equal(renders,2);
    const release=(await q('SELECT * FROM factory_releases WHERE id=$1',[id])).rows[0] as {track_id:string;output_id:string};assert.equal(release.track_id,audio.json().id);
    assert.equal((await app.inject('/api/factory/assets/'+release.output_id+'/file')).statusCode,200);
    authorized=false;assert.equal((await app.inject('/api/factory/assets/'+release.output_id+'/file')).statusCode,401);authorized=true;
    assert.equal((await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:false})).statusCode,400);assert.equal(published,0);
    const publish=await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:true});assert.equal(publish.statusCode,200,publish.body);assert.equal(published,1);
    assert.equal((await post('/api/factory/releases/'+id+'/publish',{children:'no',synthetic:'yes',rights:true})).statusCode,409);assert.equal(published,1);
    failPut=true;const failed=await upload('audio',Buffer.from('ID3-another-test-audio-more-bytes'),'Other.mp3');assert.equal(failed.statusCode,503);assert.ok(!failed.body.includes('secret'));
    assert.ok((await app.inject('/api/factory/storage')).json().reserved>0);
    failPut=false;assert.equal((await upload('audio',Buffer.from('ID3-another-test-audio-more-bytes'),'Other.mp3')).statusCode,409);
  }finally{await app.close();pool!.query=originalQuery;pool!.connect=originalConnect;await db.close();await pool!.end();}
});
