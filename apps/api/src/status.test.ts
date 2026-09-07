import { test } from 'node:test';
import assert from 'node:assert/strict';

test('missing integrations stay unconfigured; invalid responses fail; concurrent checks share cache', async () => {
  delete process.env.DATABASE_URL;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.CRON_JOB_API_KEY;
  delete process.env.YOUTUBE_REFRESH_TOKEN;
  process.env.N8N_URL = 'https://n8n.example.test';
  process.env.N8N_API_KEY = 'test-only';
  process.env.DOCKER_HEALTH_URL = 'https://docker.example.test/health';
  process.env.DOCKER_HEALTH_TOKEN = 'test-only';
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return new Response(JSON.stringify(String(url).includes('n8n') ? { data: [] } : { ok: true }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const { serviceStatus } = await import('./status.js');
    const [results, again] = await Promise.all([serviceStatus(), serviceStatus()]);
    assert.equal(calls, 2);
    assert.deepEqual(results, again);
    assert.equal(results.find(r => r.id === 'n8n')?.state, 'connected');
    assert.equal(results.find(r => r.id === 'docker')?.state, 'error');
    assert.equal(results.find(r => r.id === 'render')?.state, 'connected');
    for (const id of ['neon', 'telegram', 'cron', 'youtube']) assert.equal(results.find(r => r.id === id)?.state, 'not_configured');
    assert.ok(!JSON.stringify(results).includes('test-only'));
  } finally { globalThis.fetch = original; }
});
