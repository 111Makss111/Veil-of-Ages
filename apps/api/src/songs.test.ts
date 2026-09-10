import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { compareSong, lyricHash, type Song } from './songs-domain.js';
import { songsScript } from './songs-ui.js';

process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.PUBLIC_API_URL = 'https://api.example.test';
process.env.OPENAI_API_KEY = 'test-only-do-not-use';
process.env.SONG_DAILY_LIMIT = '10';
const { pool } = await import('./db.js');
const { songsMigration, seedSongs, startRun, finishRun, decideVersion } = await import('./songs-store.js');
const { songsRoutes } = await import('./songs.js');
const { generateSong } = await import('./songs-provider.js');
const song: Song = {
  title: 'The Bell Beneath the Waves', concept: 'A captain must choose between a sunken treasure and saving the crew of his own ship.',
  lyrics: '[Verse 1]\nThe lantern swung above the deck\nA ringing rose below the wreck\nI heard my brother call my name\nAcross the water dark as flame\n[Chorus]\nLeave the silver where it lies\nBring the living to the skies\nTurn the wheel and face the rain\nWe will find our shore again\n[Verse 2]\nThe rope was tearing in my hand\nI gave the order back to land',
  sunoPrompt: 'English nautical ballad, rough male lead, crew chorus, fiddle and deep drums, 6/8.',
  artworkPrompt: 'An original painted ship beneath emerald waves with a glowing bell, moonlight, no text.',
};
test('duplicates include normalized lyrics and reused chorus, not just shared genre words', () => {
  new Script(songsScript);
  assert.equal(lyricHash(song.lyrics), lyricHash(song.lyrics.toUpperCase().replaceAll('\n','\n\n')+'!!!'));
  const previous={...song,id:randomUUID(),project_id:randomUUID()};
  assert.equal(compareSong(song,previous)?.reason,'exact');
  const changed={...song,title:'A different story',lyrics:'[Verse 1]\nA different tale with other people\n[Chorus]\nLeave the silver where it lies\nBring the living to the skies\nTurn the wheel and face the rain\nWe will find our shore again'};
  assert.ok(['chorus','lyrics'].includes(compareSong(changed,previous)!.reason));
  assert.equal(compareSong({...song,title:'Snowfall',lyrics:'[Verse 1]\nA winter orchard wakes beneath the snow\nThe northern children watch the river flow'},previous),null);
});

test('durable projects: snapshot, idempotency, duplicates, approval, limits and authenticated routes', async () => {
  const db = new PGlite();
  const query = pool!.query, connect = pool!.connect;
  const originalFetch=globalThis.fetch;
  const q = async (sql:string,params?:unknown[]) => {
    const result=await db.query(sql,params);
    return {...result,rowCount:result.affectedRows || result.rows.length};
  };
  pool!.query=q as unknown as typeof query;
  // Serialize clients to model PostgreSQL's advisory-lock serialization on PGlite's single connection.
  let tail=Promise.resolve();
  pool!.connect=(async()=>{const before=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);await before;return{query:q,release};}) as unknown as typeof connect;
  const app=Fastify();let authorized=false;
  app.decorateRequest('ownerSession',undefined);
  app.addHook('onRequest',async req=>{if(authorized)req.ownerSession={token_hash:'test',google_sub:'owner',verified:true,enrollment_encrypted:null};});
  await app.register(songsRoutes);
  try {
    await db.exec(songsMigration);await seedSongs();
    assert.equal((await app.inject('/api/songs/projects')).statusCode,401);
    authorized=true;
    assert.equal((await app.inject({method:'POST',url:'/api/songs/projects',headers:{origin:'https://evil.test'},payload:{}})).statusCode,403);
    assert.equal((await app.inject('/songs')).statusCode,200);
    const projectId=randomUUID();const body={id:projectId,name:'Bell project',profileId:'pirate',brief:'A captain hears a bell beneath the water and must save his crew.'};
    const headers={origin:'https://api.example.test'};
    const settings={name:'Custom maritime ballads',direction:'Original stories of the sea and family.',sound:'Low male voice, fiddle and drums.',visual:'Dark green sea, original painted ships.'};
    const customId=randomUUID();
    const post=(url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers,payload});
    assert.equal((await post('/api/songs/profiles',{id:customId,settings})).statusCode,200);
    assert.equal((await post('/api/songs/profiles',{id:customId,settings})).statusCode,200);
    assert.equal((await post('/api/songs/profiles',{id:customId,settings:{...settings,name:'Conflicting style'}})).statusCode,409);
    const updated=await post('/api/songs/profiles/'+customId,{revision:1,settings:{...settings,name:'Updated custom style'}});
    assert.equal(updated.statusCode,200);assert.equal(updated.json().revision,2);
    assert.equal((await post('/api/songs/profiles/'+customId,{revision:1,settings})).statusCode,409);
    const customProject=randomUUID();
    assert.equal((await post('/api/songs/projects',{...body,id:customProject,profileId:customId})).statusCode,200);
    assert.equal((await post('/api/songs/projects',{...body,id:randomUUID(),profileId:randomUUID()})).statusCode,400);
    const create=()=>app.inject({method:'POST',url:'/api/songs/projects',headers,payload:body});
    assert.equal((await create()).statusCode,200);assert.equal((await create()).statusCode,200);
    assert.equal((await db.query('SELECT * FROM song_projects')).rows.length,2);
    const firstKey=randomUUID();const claimed=await startRun(projectId,firstKey,'test-model',10);
    const snapshot=claimed.run.snapshot;
    const concurrent=await Promise.all([startRun(projectId,firstKey,'test-model',10),startRun(projectId,firstKey,'test-model',10)]);
    assert.ok(concurrent.every(c=>!c.fresh&&c.run.id===claimed.run.id));
    await assert.rejects(startRun(projectId,randomUUID(),'test-model',10),/Уже працює/);
    await db.query("UPDATE song_profiles SET settings=jsonb_set(settings,'{name}','\"Edited style\"'),revision=revision+1 WHERE id='pirate'");
    await seedSongs();
    assert.equal((await db.query<{settings:{name:string}}>("SELECT settings FROM song_profiles WHERE id='pirate'")).rows[0]!.settings.name,'Edited style');
    assert.notEqual(snapshot.profile.name,'Edited style');
    await finishRun(claimed.run.id,song,100,200);
    await finishRun(claimed.run.id,song,100,200);
    const versions=(await db.query<{id:string}>('SELECT id FROM song_versions')).rows;
    assert.equal(versions.length,1);
    await decideVersion(projectId,versions[0]!.id,'rejected');
    const second=await startRun(projectId,randomUUID(),'test-model',10);
    await finishRun(second.run.id,song,100,200);
    const duplicate=(await db.query<{id:string;matches:unknown[]}>('SELECT id,matches FROM song_versions WHERE run_id=$1',[second.run.id])).rows[0];
    assert.ok(duplicate);
    assert.ok(duplicate.matches.length);
    await assert.rejects(decideVersion(projectId,duplicate.id,'approved'),/Виявлено повтор/);
    await assert.rejects(startRun(projectId,randomUUID(),'test-model',2),/ліміту/);
    await decideVersion(projectId,versions[0]!.id,'approved');
    await assert.rejects(startRun(projectId,randomUUID(),'test-model',10),/затверджено/);
    await decideVersion(projectId,versions[0]!.id,'rejected');
    const interrupted=await startRun(projectId,randomUUID(),'test-model',10);
    await db.query("UPDATE song_runs SET created_at=NOW()-INTERVAL '6 minutes' WHERE id=$1",[interrupted.run.id]);
    const read=await app.inject('/api/songs/projects/'+projectId);
    assert.equal(read.statusCode,200,read.body);
    assert.ok(read.json().runs.some((r:{id:string;state:string})=>r.id===interrupted.run.id&&r.state==='uncertain'));
    const providerBody={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({...song,title:'New distinct title',lyrics:song.lyrics.replaceAll('the','a')})}]}],usage:{input_tokens:150,output_tokens:300}};
    let calls=0,releaseProvider!:()=>void;
    const gate=new Promise<void>(r=>releaseProvider=r);
    globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(JSON.parse(String(options?.body)).store,false);await gate;return new Response(JSON.stringify(providerBody),{status:200});};
    const key=randomUUID();const generate=()=>app.inject({method:'POST',url:'/api/songs/projects/'+projectId+'/generate',headers,payload:{requestKey:key}});
    const started=await generate();assert.equal(started.statusCode,202,started.body);
    assert.equal((await generate()).json().reused,true);assert.equal(calls,1);releaseProvider();
    await app.close();
    const finished=await db.query<{state:string}>('SELECT state FROM song_runs WHERE request_key=$1',[key]);assert.equal(finished.rows[0]!.state,'complete');
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(generateSong('prompt',new AbortController().signal),/OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY='test-only-do-not-use';
    globalThis.fetch=async()=>new Response(JSON.stringify({error:'secret-token-must-not-leak'}),{status:401});
    await assert.rejects(generateSong('prompt',new AbortController().signal),e=>e instanceof Error&&!e.message.includes('secret-token')&&e.message.includes('Ключ'));
  } finally { globalThis.fetch=originalFetch;await app.close();pool!.query=query;pool!.connect=connect;await db.close();await pool!.end(); }
});
