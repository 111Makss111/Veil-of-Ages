import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

process.env.PUBLIC_API_URL = 'https://api.example.test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.YOUTUBE_REFRESH_TOKEN = 'test-refresh';
process.env.YOUTUBE_SETUP_SECRET = 'test-upload-secret-'.repeat(3);
const { sendPrivateVideo, isMp4, youtubeUploadRoutes, MAX_VIDEO_BYTES } = await import('./youtube-upload.js');
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
      assert.ok(String(_url).includes('notifySubscribers=false'));
      return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test' } });
    }
    assert.equal(init!.method, 'PUT');
    assert.deepEqual(Buffer.from(init!.body as Uint8Array), file);
    return new Response(JSON.stringify({ id: 'abcdefghijk', status: { privacyStatus: 'private' } }), { status: 201 });
  };
  try {
    assert.equal(await sendPrivateVideo(file, { title: 'Тест', children: 'no', synthetic: 'yes' }, 'secret-token'), 'abcdefghijk');
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
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
