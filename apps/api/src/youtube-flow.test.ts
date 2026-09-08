import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.PUBLIC_API_URL = 'https://api.example.test';
process.env.YOUTUBE_CLIENT_ID = 'test-client';
process.env.YOUTUBE_CLIENT_SECRET = 'test-client-secret';
process.env.YOUTUBE_SETUP_SECRET = 'test-setup-secret-'.repeat(4);
const { pool } = await import('./db.js');
const { youtubeRoutes, unseal } = await import('./youtube.js');

test('OAuth rejects unauthorized starts, binds browser, consumes state once and encrypts token', async () => {
  const originalQuery = pool!.query;
  const originalFetch = globalThis.fetch;
  let state: { hash: string; browser: string; verifier: string } | undefined;
  let saved = '';
  let exchanges = 0;
  pool!.query = (async (sql: string, values: string[]) => {
    if (sql.startsWith('INSERT INTO youtube_oauth_states')) {
      state = { hash: values[0]!, browser: values[1]!, verifier: values[2]! };
    }
    if (sql.startsWith('DELETE FROM youtube_oauth_states WHERE state_hash')) {
      if (state && state.hash === values[0] && state.browser === values[1]) {
        const verifier = state.verifier;
        state = undefined;
        return { rows: [{ verifier_encrypted: verifier }] };
      }
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO youtube_connection')) saved = values[0]!;
    return { rows: [] };
  }) as typeof originalQuery;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const body = init!.body as URLSearchParams;
    assert.equal(body.get('redirect_uri'), 'https://api.example.test/auth/youtube/callback');
    assert.ok(body.get('code_verifier'));
    exchanges++;
    return new Response(JSON.stringify({ access_token: 'access-private', refresh_token: 'refresh-private', scope: 'https://www.googleapis.com/auth/youtube.upload' }));
  };
  const app = Fastify();
  await app.register(youtubeRoutes);
  try {
    const post = (secret: string, origin = 'https://api.example.test') => app.inject({ method: 'POST', url: '/auth/youtube/start', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ secret }).toString() });
    assert.equal((await post('wrong')).statusCode, 401);
    assert.equal((await post(process.env.YOUTUBE_SETUP_SECRET!, 'https://evil.test')).statusCode, 403);
    const start = await post(process.env.YOUTUBE_SETUP_SECRET!);
    assert.equal(start.statusCode, 303);
    const destination = new URL(start.headers.location!);
    assert.equal(destination.origin, 'https://accounts.google.com');
    assert.equal(destination.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(destination.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.upload');
    const cookie = String(start.headers['set-cookie']).split(';')[0]!;
    assert.match(String(start.headers['set-cookie']), /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
    const callback = '/auth/youtube/callback?' + new URLSearchParams({ state: destination.searchParams.get('state')!, code: 'private-code' });
    assert.equal((await app.inject({ url: callback })).statusCode, 400);
    assert.equal(exchanges, 0);
    const complete = await app.inject({ url: callback, headers: { cookie } });
    assert.equal(complete.statusCode, 303);
    assert.equal(complete.headers.location, '/auth/youtube/success');
    assert.equal(unseal(saved, process.env.YOUTUBE_SETUP_SECRET!), 'refresh-private');
    assert.ok(!saved.includes('refresh-private'));
    assert.equal((await app.inject({ url: callback, headers: { cookie } })).statusCode, 400);
    assert.equal(exchanges, 1);
    assert.ok(!complete.body.includes('refresh-private'));
  } finally {
    await app.close();
    pool!.query = originalQuery;
    globalThis.fetch = originalFetch;
    await pool!.end();
  }
});
