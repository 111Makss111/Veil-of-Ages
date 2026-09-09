import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import Fastify from 'fastify';
import { mediaKind, runMediaTool } from './media-render.js';
import { mediaScript } from './media-ui.js';

process.env.PUBLIC_API_URL = 'https://api.example.test';
process.env.YOUTUBE_SETUP_SECRET = 'media-test-secret-'.repeat(3);
const { mediaRoutes } = await import('./media.js');

test('supported file signatures and browser script syntax', () => {
  assert.equal(mediaKind(Buffer.from([255,216,255]), true), 'jpg');
  assert.equal(mediaKind(Buffer.from([137,80,78,71,13,10,26,10]), true), 'png');
  assert.equal(mediaKind(Buffer.from('ID3test'), false), 'mp3');
  assert.equal(mediaKind(Buffer.from('RIFF0000WAVE'), false), 'wav');
  assert.throws(() => mediaKind(Buffer.from('#EXTM3U\nhttps://example.com'), false));
  assert.throws(() => mediaKind(Buffer.from('<svg></svg>'), true));
  new Script(mediaScript);
});

test('missing executable fails without hanging or exposing paths', async () => {
  await assert.rejects(runMediaTool('nonexistent-veil-tool', [], 1000), /Не вдалося обробити/);
});

test('media files require authentication; invalid origin is rejected', async () => {
  const app = Fastify();
  await app.register(mediaRoutes);
  try {
    assert.equal((await app.inject('/media')).statusCode, 200);
    assert.equal((await app.inject('/media/jobs/not-a-job/file')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/media/jobs', headers: { origin: 'https://evil.test', 'x-setup-secret': process.env.YOUTUBE_SETUP_SECRET! } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/media/jobs/not-a-job', headers: { 'x-setup-secret': process.env.YOUTUBE_SETUP_SECRET! } })).statusCode, 404);
  } finally { await app.close(); }
});

test('real picture and audio produce downloadable MP4 through job routes', { skip: !process.env.MEDIA_TEST_IMAGE || !process.env.MEDIA_TEST_AUDIO }, async () => {
  const image = await readFile(process.env.MEDIA_TEST_IMAGE!);
  const audio = await readFile(process.env.MEDIA_TEST_AUDIO!);
  const boundary = 'veil-test-boundary';
  const part = (name: string, filename: string, type: string, data: Buffer) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from('\r\n')]);
  const payload = Buffer.concat([part('image', '../../test.jpg', 'image/jpeg', image), part('audio', 'test.mp3', 'audio/mpeg', audio), Buffer.from(`--${boundary}--\r\n`)]);
  const app = Fastify();
  await app.register(mediaRoutes);
  const headers = { 'x-setup-secret': process.env.YOUTUBE_SETUP_SECRET! };
  try {
    const start = await app.inject({ method: 'POST', url: '/media/jobs', headers: { ...headers, origin: 'https://api.example.test', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(start.statusCode, 202, start.body);
    const id = start.json().id;
    const duplicate = await app.inject({ method: 'POST', url: '/media/jobs', headers: { ...headers, origin: 'https://api.example.test', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(duplicate.statusCode, 429);
    const deadline = Date.now() + 60000;
    while (true) {
      const status = (await app.inject({ url: `/media/jobs/${id}`, headers })).json();
      assert.notEqual(status.state, 'error', status.error);
      if (status.state === 'ready') break;
      assert.ok(Date.now() < deadline, 'Timed out');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const result = await app.inject({ url: `/media/jobs/${id}/file`, headers });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['content-type'], 'video/mp4');
    assert.equal(result.rawPayload.toString('ascii', 4, 8), 'ftyp');
    assert.ok(result.rawPayload.length > 10000);
    assert.ok(result.rawPayload.length <= 24 * 1024 * 1024);
  } finally { await app.close(); }
});
