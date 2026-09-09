import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import Fastify from 'fastify';
import { TOTP, Secret } from 'otpauth';
import type { TokenPayload } from 'google-auth-library';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.PUBLIC_API_URL = 'https://api.example.test';
process.env.AUTH_SECRET = 'auth-test-'.repeat(8);
process.env.YOUTUBE_CLIENT_ID = 'client';
process.env.YOUTUBE_CLIENT_SECRET = 'secret';
const { validOwner, totpStep, installOwnerAuth } = await import('./owner-auth.js');
const { accountScript } = await import('./owner-ui.js');
const { pool } = await import('./db.js');

test('owner identity requires verified email and matching nonce', () => {
  const payload = { email: '777docmax777@gmail.com', email_verified: true, sub: 'owner', nonce: 'nonce' } as unknown as TokenPayload;
  assert.equal(validOwner(payload, 'nonce'), true);
  assert.equal(validOwner({ ...payload, email: 'attacker@gmail.com' }, 'nonce'), false);
  assert.equal(validOwner({ ...payload, email_verified: false }, 'nonce'), false);
  assert.equal(validOwner(payload, 'other'), false);
  new Script(accountScript);
});
test('TOTP rejects wrong length, expired codes and replay', () => {
  const secret = new Secret({ size: 20 });
  const otp = new TOTP({ secret, digits: 6, period: 30 });
  const now = 1700000000000;
  const token = otp.generate({ timestamp: now });
  const step = totpStep(secret.base32, token, -1, now);
  assert.equal(step, Math.floor(now / 30000));
  assert.equal(totpStep(secret.base32, token, step!, now), null);
  assert.equal(totpStep(secret.base32, token, -1, now + 120000), null);
  assert.equal(totpStep(secret.base32, token.slice(0, 5), -1, now), null);
});
test('global boundary blocks secret-only and Google-only access, enforces CSRF and permits full sessions', async () => {
  const original = pool!.query;
  let verified = false;
  pool!.query = (async () => ({ rows: [{ token_hash: 'hash', google_sub: 'owner', verified }] })) as unknown as typeof original;
  const app = Fastify();
  await installOwnerAuth(app);
  const routes = ['/api/status', '/media', '/media/jobs/123/file', '/youtube/upload', '/auth/youtube', '/auth/youtube/callback', '/api/telegram/link/123'];
  for (const url of routes) app.get(url, async () => ({ private: true }));
  app.post('/media/jobs', async () => ({ private: true }));
  app.get('/health', async () => ({ ok: true }));
  const cookie = '__Host-studio=' + 'a'.repeat(43);
  try {
    for (const url of routes) {
      assert.equal((await app.inject({ url, headers: { 'x-setup-secret': 'any-legacy-secret' } })).statusCode, 401, url);
      assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 401, url);
    }
    assert.equal((await app.inject('/account/login')).statusCode, 200);
    assert.equal((await app.inject('/health')).statusCode, 200);
    verified = true;
    for (const url of routes) assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/media/jobs', headers: { cookie, origin: 'https://evil.test' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/media/jobs', headers: { cookie, origin: 'https://api.example.test' } })).statusCode, 200);
  } finally { await app.close(); pool!.query = original; await pool!.end(); }
});
