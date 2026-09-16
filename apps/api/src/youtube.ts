import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { pool, requirePool } from './db.js';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
] as const;
export const DEFAULT_YOUTUBE_CHANNEL_ID='UCf6q4aVKDAs6lxDzp-dzJEg';
const scope = YOUTUBE_SCOPES.join(' ');
const hasRequiredScopes=(value:string|undefined)=>!value||YOUTUBE_SCOPES.every(required=>value.split(' ').includes(required));
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':'&quot;',"'":'&#39;'}[char]!));

export type YoutubeChannelIdentity={id:string;title:string};
export class YoutubeChannelMismatchError extends Error {
  constructor(public readonly channel:YoutubeChannelIdentity){super(`Google підключив канал «${channel.title}» (${channel.id}), але потрібен Veil of Ages (${process.env.YOUTUBE_CHANNEL_ID?.trim()||DEFAULT_YOUTUBE_CHANNEL_ID}). У вікні Google вибери саме YouTube-канал Veil of Ages, а не особистий профіль.`);this.name='YoutubeChannelMismatchError';}
}

export async function getYoutubeChannelIdentity(accessToken:string):Promise<YoutubeChannelIdentity>{
  const url=new URL('https://www.googleapis.com/youtube/v3/channels');url.search=new URLSearchParams({part:'id,snippet',mine:'true'}).toString();
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${accessToken}`}});
  if(!response.ok)throw new Error('YouTube channel identity unavailable');
  const data=z.object({items:z.array(z.object({id:z.string().min(1),snippet:z.object({title:z.string().min(1)})}))}).parse(await response.json());
  const channel=data.items[0];if(!channel)throw new Error('YouTube channel identity unavailable');
  return {id:channel.id,title:channel.snippet.title};
}

export async function requireVeilOfAgesChannel(accessToken:string):Promise<YoutubeChannelIdentity>{
  const channel=await getYoutubeChannelIdentity(accessToken),expectedId=process.env.YOUTUBE_CHANNEL_ID?.trim()||DEFAULT_YOUTUBE_CHANNEL_ID;
  if(channel.id!==expectedId)throw new YoutubeChannelMismatchError(channel);
  return channel;
}

export function seal(value: string, secret: string): string {
  const key = createHash('sha256').update('youtube-token-encryption:').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
}

export function unseal(value: string, secret: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted token');
  const [iv, tag, encrypted] = parts.map(p => Buffer.from(p, 'base64url'));
  const key = createHash('sha256').update('youtube-token-encryption:').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8');
}

export function setupSecretMatches(value: string, expected: string): boolean {
  return expected.length >= 32 && timingSafeEqual(Buffer.from(hash(value)), Buffer.from(hash(expected)));
}

export async function getYoutubeRefreshToken(): Promise<string | undefined> {
  if (pool && process.env.YOUTUBE_SETUP_SECRET) {
    const result = await pool.query('SELECT refresh_token_encrypted FROM youtube_connection WHERE id = 1');
    if (result.rows[0]) return unseal(result.rows[0].refresh_token_encrypted, process.env.YOUTUBE_SETUP_SECRET);
  }
  return process.env.YOUTUBE_REFRESH_TOKEN || undefined;
}

const tokenResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), scope: z.string().optional() });
export async function googleToken(parameters: Record<string, string>) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams(parameters),
    redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Google authorization failed');
  return tokenResponse.parse(await response.json());
}

export async function youtubeRoutes(app: FastifyInstance) {
  const origin = (config.PUBLIC_API_URL ?? (config.RENDER_EXTERNAL_HOSTNAME ? `https://${config.RENDER_EXTERNAL_HOSTNAME}` : 'http://localhost:4000')).replace(/\/$/, '');
  const redirectUri = `${origin}/auth/youtube/callback`;
  const secret = process.env.YOUTUBE_SETUP_SECRET ?? '';
  const clientId = process.env.YOUTUBE_CLIENT_ID ?? '';
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET ?? '';
  const ready = () => !!(pool && clientId && clientSecret && secret.length >= 32 && (origin.startsWith('https://') || config.NODE_ENV !== 'production'));
  const cookie = (value: string, age: number) => `youtube_oauth=${value}; Path=/auth/youtube; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith('https://') ? '; Secure' : ''}`;
  const page = (text: string) => `<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>YouTube · Veil of Ages</title><body><main><h1>YouTube · Veil of Ages</h1>${text}</main></body></html>`;

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'");
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/auth/youtube', { logLevel: 'silent' }, async (_request, reply) => {
    // no-referrer makes browsers send Origin: null on native form POSTs.
    // Only the setup form needs same-origin; the OAuth callback stays no-referrer.
    reply.header('Referrer-Policy', 'same-origin');
    if (!ready()) return reply.code(503).type('text/html').send(page('<p>Потрібні DATABASE_URL, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET та YOUTUBE_SETUP_SECRET (мінімум 32 символи).</p>'));
    return reply.type('text/html').send(page('<p>Підключіть Google-акаунт, який керує потрібним каналом. Відео зараз не завантажується.</p><form method="post" action="/auth/youtube/start"><label>Секрет налаштування з Render <input name="secret" type="password" required autocomplete="off"></label><button type="submit">Підключити YouTube через Google</button></form>'));
  });

  app.post('/auth/youtube/start', { logLevel: 'silent', bodyLimit: 4096 }, async (request, reply) => {
    if (!ready()) return reply.code(503).send({ error: 'YouTube setup is not configured' });
    if (request.headers.origin !== origin) return reply.code(403).send({ error: 'Invalid origin' });
    const body = z.object({ secret: z.string().max(1024) }).safeParse(request.body);
    if (!request.ownerSession?.verified && (!body.success || !setupSecretMatches(body.data.secret, secret))) return reply.code(401).send({ error: 'Invalid setup secret' });
    try {
      const state = random(), browser = random(), verifier = random();
      const db = requirePool();
      await db.query('DELETE FROM youtube_oauth_states WHERE expires_at < NOW()');
      await db.query("INSERT INTO youtube_oauth_states(state_hash, browser_hash, verifier_encrypted, expires_at) VALUES ($1,$2,$3,NOW() + INTERVAL '10 minutes')", [hash(state), hash(browser), seal(verifier, secret)]);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, access_type: 'offline', include_granted_scopes:'true', prompt: 'consent select_account', state, code_challenge: hash(verifier), code_challenge_method: 'S256' }).toString();
      return reply.header('Set-Cookie', cookie(browser, 600)).redirect(url.toString(), 303);
    } catch {
      return reply.code(503).send({ error: 'Unable to start authorization; try again' });
    }
  });

  app.get('/auth/youtube/callback', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Set-Cookie', cookie('', 0));
    if (!ready()) return reply.code(503).send({ error: 'YouTube setup is not configured' });
    const query = z.object({ state: z.string().regex(/^[\w-]{43}$/), code: z.string().min(1).max(4096).optional(), error: z.string().max(256).optional() }).safeParse(request.query);
    const browser = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('youtube_oauth='))?.slice('youtube_oauth='.length);
    if (!query.success || !browser || !/^[\w-]{43}$/.test(browser)) return reply.code(400).type('text/html').send(page('<p>Сесія недійсна. Почніть підключення заново.</p>'));
    try {
      const result = await requirePool().query('DELETE FROM youtube_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at > NOW() RETURNING verifier_encrypted', [hash(query.data.state), hash(browser)]);
      if (!result.rows[0]) return reply.code(400).type('text/html').send(page('<p>Сесія минула або вже використана. Почніть підключення заново.</p>'));
      if (query.data.error || !query.data.code) return reply.code(400).type('text/html').send(page('<p>Дозвіл не надано. Підключення не змінено.</p>'));
      const token = await googleToken({ client_id: clientId, client_secret: clientSecret, code: query.data.code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: unseal(result.rows[0].verifier_encrypted, secret) });
      if (!token.refresh_token || !hasRequiredScopes(token.scope)) throw new Error('YouTube upload/read permission or offline access missing');
      await requireVeilOfAgesChannel(token.access_token);
      await requirePool().query('INSERT INTO youtube_connection(id, refresh_token_encrypted) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET refresh_token_encrypted=EXCLUDED.refresh_token_encrypted, updated_at=NOW()', [seal(token.refresh_token, secret)]);
      return reply.redirect('/auth/youtube/success', 303);
    } catch(error) {
      if(error instanceof YoutubeChannelMismatchError)return reply.code(409).type('text/html').send(page(`<p>${escapeHtml(error.message)}</p><p><a href="/auth/youtube">Підключити інший канал</a></p>`));
      return reply.code(502).type('text/html').send(page('<p>Не вдалося зберегти доступ. Перевірте налаштування Google й спробуйте підключити ще раз. Секрети не показуються.</p>'));
    }
  });
  app.get('/auth/youtube/success', async (_request, reply) => reply.type('text/html').send(page('<p>Якщо Google щойно перенаправив вас сюди, доступ збережено. Поверніться на сайт і оновіть статуси. Завантаження відео ще не виконувалось.</p>')));
}
