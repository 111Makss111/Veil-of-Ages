import { pool } from './db.js';
import { config } from './config.js';
import { getYoutubeRefreshToken, googleToken } from './youtube.js';

type Check = { id: string; state: 'connected' | 'error' | 'not_configured'; detail: string; checkedAt: string };
const cache = new Map<string, { until: number; promise: Promise<Check> }>();
async function check(id: string, configured: boolean, run: () => Promise<string>, ttl = 30000): Promise<Check> {
  const previous = cache.get(id);
  if (previous && previous.until > Date.now()) return previous.promise;
  const promise = (async (): Promise<Check> => {
    if (!configured) return { id, state: 'not_configured', detail: 'Підключення ще не налаштовано', checkedAt: new Date().toISOString() };
    try { return { id, state: 'connected', detail: await run(), checkedAt: new Date().toISOString() }; }
    catch { return { id, state: 'error', detail: 'Перевірка не пройшла: перевірте доступи та доступність сервісу', checkedAt: new Date().toISOString() }; }
  })();
  cache.set(id, { until: Date.now() + ttl, promise });
  return promise;
}
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('Probe failed');
  return response.json();
}
async function youtubeStatus(): Promise<Check> {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    const cachedEmpty=await check('youtube',false,async()=>'',300000);
    return { ...cachedEmpty, detail: 'Потрібно надати доступ через Google' };
  }
  const empty: Check = { id: 'youtube', state: 'not_configured', detail: 'Потрібно надати доступ через Google', checkedAt: new Date().toISOString() };
  try {
    const refresh = await getYoutubeRefreshToken();
    if (!refresh) return empty;
    return check('youtube', true, async () => {
      const token = await googleToken({ client_id: process.env.YOUTUBE_CLIENT_ID!, client_secret: process.env.YOUTUBE_CLIENT_SECRET!, refresh_token: refresh, grant_type: 'refresh_token' });
      if (token.scope && !token.scope.split(' ').includes('https://www.googleapis.com/auth/youtube.upload')) throw new Error('Missing upload scope');
      return 'Доступ Google активний; завантаження ролика ще потрібно перевірити';
    }, 300000);
  } catch {
    return { ...empty, state: 'error', detail: 'Не вдалося прочитати доступ YouTube; перевірте базу та секрет налаштування' };
  }
}
export async function serviceStatus() {
  const env = process.env;
  return Promise.all([
    check('render', true, async () => 'API відповідає'),
    check('neon', !!pool, async () => { await pool!.query('SELECT 1'); return 'Запит до бази успішний'; }),
    check('telegram', !!(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_WEBHOOK_SECRET && config.TELEGRAM_BOT_USERNAME), async () => {
      const base = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
      const [me, hook] = await Promise.all([json(`${base}/getMe`), json(`${base}/getWebhookInfo`)]);
      const origin = config.PUBLIC_API_URL ?? (config.RENDER_EXTERNAL_HOSTNAME ? `https://${config.RENDER_EXTERNAL_HOSTNAME}` : '');
      if (!me.ok || !hook.ok || me.result.username?.toLowerCase() !== config.TELEGRAM_BOT_USERNAME?.toLowerCase() || !origin || hook.result.url !== `${origin.replace(/\/$/, '')}/webhooks/telegram`) throw new Error('Webhook mismatch');
      if (hook.result.pending_update_count > 0 && hook.result.last_error_date > Date.now() / 1000 - 600) throw new Error('Delivery failed');
      return 'Бот доступний, webhook спрямований на цей API';
    }),
    check('n8n', !!(env.N8N_URL && env.N8N_API_KEY), async () => {
      const data = await json(`${env.N8N_URL!.replace(/\/$/, '')}/api/v1/workflows?limit=1`, { headers: { 'X-N8N-API-KEY': env.N8N_API_KEY! } });
      if (!Array.isArray(data.data)) throw new Error('Invalid response');
      return 'Доступ до API n8n підтверджено';
    }),
    check('cron', !!env.CRON_JOB_API_KEY, async () => {
      const data = await json('https://api.cron-job.org/jobs', { headers: { Authorization: `Bearer ${env.CRON_JOB_API_KEY}` } });
      if (!Array.isArray(data.jobs) || data.someFailed) throw new Error('Invalid response');
      return 'Доступ до cron-job.org підтверджено; виконання завдань не перевіряється';
    }, 1800000),
    check('docker', !!(env.DOCKER_HEALTH_URL && env.DOCKER_HEALTH_TOKEN), async () => {
      const data = await json(env.DOCKER_HEALTH_URL!, { headers: { Authorization: `Bearer ${env.DOCKER_HEALTH_TOKEN}` } });
      if (data.service !== 'docker' || data.ok !== true) throw new Error('Invalid health response');
      return 'Стан Docker підтверджено агентом перевірки';
    }),
    youtubeStatus()
  ]);
}
