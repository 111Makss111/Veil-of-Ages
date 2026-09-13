import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

process.env.PUBLIC_API_URL = 'https://api.example.test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.YOUTUBE_REFRESH_TOKEN = 'test-refresh';
process.env.YOUTUBE_SETUP_SECRET = 'test-upload-secret-'.repeat(3);
const { sendPrivateVideo, setVideoThumbnail, isMp4, youtubeUploadRoutes, MAX_VIDEO_BYTES } = await import('./youtube-upload.js');
const file = Buffer.from('0000ftypisom0000');
const { pool } = await import('./db.js');

test('upload always requests private visibility and returns confirmed video ID', async () => {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init!);
    if (calls.length === 1) {
      const data = JSON.parse(init!.body as string);
      assert.equal(data.status.privacyStatus, 'private');
      assert.equal(data.status.selfDeclaredMadeForKids, false);
      assert.equal(data.status.containsSyntheticMedia, true);
      assert.equal(data.snippet.description,'A northern oath and a journey home.');
      assert.deepEqual(data.snippet.tags,['Viking music','Veil of Ages']);
      assert.ok(String(_url).includes('notifySubscribers=false'));
      return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test' } });
    }
    assert.equal(init!.method, 'PUT');
    assert.deepEqual(Buffer.from(init!.body as Uint8Array), file);
    return new Response(JSON.stringify({ id: 'abcdefghijk', status: { privacyStatus: 'private' } }), { status: 201 });
  };
  try {
    assert.equal(await sendPrivateVideo(file, { title: 'Тест', children: 'no', synthetic: 'yes',description:'A northern oath and a journey home.',tags:['Viking music','Veil of Ages'] }, 'secret-token'), 'abcdefghijk');
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

test('generated artwork can be set as the private video thumbnail',async()=>{
  const original=globalThis.fetch,png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40)]);let called=false;
  globalThis.fetch=async(url,init)=>{called=true;assert.equal(String(url),'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=abcdefghijk');assert.equal(init?.method,'POST');assert.equal((init?.headers as Record<string,string>)['Content-Type'],'image/png');assert.deepEqual(Buffer.from(init?.body as Uint8Array),png);return new Response(JSON.stringify({items:[{}]}),{status:200});};
  try{await setVideoThumbnail(png,'image/png','abcdefghijk','secret-token');assert.equal(called,true);}finally{globalThis.fetch=original;}
});

test('thumbnail upload retries while a new video is not yet visible to YouTube',async()=>{
  const original=globalThis.fetch,jpg=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(40)]);let calls=0,waits=0;
  globalThis.fetch=async()=>{calls++;return calls===1?new Response(JSON.stringify({error:{errors:[{reason:'videoNotFound'}]}}),{status:404}):new Response('{}',{status:200});};
  try{await setVideoThumbnail(jpg,'image/jpeg','abcdefghijk','secret-token',async()=>{waits++;});assert.equal(calls,2);assert.equal(waits,1);}finally{globalThis.fetch=original;}
});

test('thumbnail permission errors explain channel verification without leaking provider details',async()=>{
  const original=globalThis.fetch,jpg=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(40)]);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'private provider detail',errors:[{reason:'forbidden'}]}}),{status:403});
  try{await assert.rejects(setVideoThumbnail(jpg,'image/jpeg','abcdefghijk','secret-token'),error=>error instanceof Error&&/Підтвердь канал/.test(error.message)&&!error.message.includes('private provider detail'));}finally{globalThis.fetch=original;}
});

test('untrusted upload destinations never receive the token or file', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { headers: { location: 'https://evil.test/upload' } }); };
  try {
    await assert.rejects(sendPrivateVideo(file, { title: 'Test', children: 'no', synthetic: 'yes' }, 'secret-token'));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('form serves locally, unauthenticated uploads fail before body parsing, invalid inputs fail', async () => {
  const app = Fastify();
  await app.register(youtubeUploadRoutes);
  try {
    assert.equal(isMp4(file), true);
    assert.equal(isMp4(Buffer.from('not a video')), false);
    const page = await app.inject('/youtube/upload');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('приватне відео'));
    assert.equal(page.headers['referrer-policy'], 'same-origin');
    assert.ok(!page.body.includes(process.env.YOUTUBE_SETUP_SECRET!));
    const headers = { origin: 'https://api.example.test', 'content-type': 'video/mp4', 'x-setup-secret': process.env.YOUTUBE_SETUP_SECRET! };
    assert.equal((await app.inject({ method: 'POST', url: '/youtube/upload', payload: file })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/youtube/upload', headers: { ...headers, origin: 'null' }, payload: file })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/youtube/upload', headers, payload: file })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/youtube/upload', headers: { ...headers, 'content-length': String(MAX_VIDEO_BYTES + 1) }, payload: file })).statusCode, 413);
  } finally { await app.close(); }
});

test('duplicate file returns saved video without a second upload', async () => {
  const originalFetch = globalThis.fetch, originalQuery = pool!.query;
  let saved = false, uploads = 0;
  pool!.query = (async (sql: string) => {
    if (sql.startsWith('INSERT INTO youtube_uploads')) return { rows: saved ? [] : [{ file_hash: 'test' }] };
    if (sql.startsWith('UPDATE youtube_uploads')) saved = true;
    if (sql.startsWith('SELECT state,video_id')) return { rows: [{ state: 'complete', video_id: 'abcdefghijk' }] };
    return { rows: [] };
  }) as typeof originalQuery;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'test-access' }));
    if (init!.method === 'POST') return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test' } });
    uploads++;
    return new Response(JSON.stringify({ id: 'abcdefghijk', status: { privacyStatus: 'private' } }), { status: 201 });
  };
  const app = Fastify();
  await app.register(youtubeUploadRoutes);
  try {
    const request = { method: 'POST' as const, url: '/youtube/upload?title=Test&children=no&synthetic=yes', headers: { origin: 'https://api.example.test', 'content-type': 'video/mp4', 'x-setup-secret': process.env.YOUTUBE_SETUP_SECRET! }, payload: file };
    assert.deepEqual((await app.inject(request)).json(), { videoId: 'abcdefghijk', duplicate: false });
    assert.deepEqual((await app.inject(request)).json(), { videoId: 'abcdefghijk', duplicate: true });
    assert.equal(uploads, 1);
  } finally { await app.close(); pool!.query = originalQuery; globalThis.fetch = originalFetch; await pool!.end(); }
});
