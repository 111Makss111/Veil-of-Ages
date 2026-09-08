import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

delete process.env.DATABASE_URL;
const { seal, unseal, setupSecretMatches, youtubeRoutes, googleToken } = await import('./youtube.js');

test('tokens use authenticated encryption; wrong key and tampering are rejected', () => {
  const secret = 'a'.repeat(43);
  const encrypted = seal('private-refresh-token', secret);
  assert.equal(unseal(encrypted, secret), 'private-refresh-token');
  assert.ok(!encrypted.includes('private-refresh-token'));
  assert.notEqual(encrypted, seal('private-refresh-token', secret));
  assert.throws(() => unseal(encrypted, 'b'.repeat(43)));
  const parts = encrypted.split('.');
  parts[2] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => unseal(parts.join('.'), secret));
  assert.throws(() => unseal('invalid', secret));
});

test('setup secret is required and compared safely', () => {
  assert.equal(setupSecretMatches('a'.repeat(43), 'a'.repeat(43)), true);
  assert.equal(setupSecretMatches('wrong', 'a'.repeat(43)), false);
  assert.equal(setupSecretMatches('', ''), false);
});

test('unconfigured OAuth routes fail closed and disable caching', async () => {
  const app = Fastify();
  await app.register(youtubeRoutes);
  try {
    for (const url of ['/auth/youtube', '/auth/youtube/callback?code=private']) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.ok(!response.body.includes('private'));
    }
  } finally { await app.close(); }
});

test('Google error bodies containing secrets are not propagated', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('private-refresh-token', { status: 400 });
  try { await assert.rejects(googleToken({}), { message: 'Google authorization failed' }); }
  finally { globalThis.fetch = original; }
});
