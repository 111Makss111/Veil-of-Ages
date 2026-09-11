import { spawn } from 'node:child_process';

// Refuse ephemeral SQLite: workflows and credentials must survive redeploys.
const env = { ...process.env };
for (const key of ['DB_POSTGRESDB_HOST', 'DB_POSTGRESDB_DATABASE', 'DB_POSTGRESDB_USER', 'DB_POSTGRESDB_PASSWORD', 'N8N_ENCRYPTION_KEY']) {
  if (!env[key]) throw new Error(`Missing required configuration: ${key}`);
}
if (env.N8N_ENCRYPTION_KEY.length < 32) throw new Error('N8N_ENCRYPTION_KEY must contain at least 32 characters');
const origin = new URL(env.N8N_PUBLIC_URL || env.RENDER_EXTERNAL_URL || '');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('A public HTTPS origin is required');
Object.assign(env, {
  DB_TYPE: 'postgresdb',
  DB_POSTGRESDB_SSL_ENABLED: 'true',
  DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: 'true',
  N8N_HOST: origin.hostname,
  N8N_PROTOCOL: 'https',
  N8N_PORT: '5678',
  N8N_LISTEN_ADDRESS: '0.0.0.0',
  N8N_PROXY_HOPS: '1',
  WEBHOOK_URL: origin.origin + '/',
  N8N_EDITOR_BASE_URL: origin.origin,
  N8N_SECURE_COOKIE: 'true',
  N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
  N8N_BLOCK_ENV_ACCESS_IN_NODE: 'true',
  N8N_COMMUNITY_PACKAGES_ENABLED: 'false',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  EXECUTIONS_DATA_PRUNE: 'true',
  EXECUTIONS_DATA_MAX_AGE: '168',
  EXECUTIONS_DATA_PRUNE_MAX_COUNT: '1000',
  GENERIC_TIMEZONE: 'Europe/Warsaw',
  TZ: 'Europe/Warsaw',
});
const child = spawn('n8n', ['start'], { env, stdio: 'inherit', shell: false });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.once('error', () => { console.error('Unable to start n8n'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
