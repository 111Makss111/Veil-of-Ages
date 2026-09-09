import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { requirePool } from './db.js';
import { seal, unseal, setupSecretMatches } from './youtube.js';
import { accountPage, accountScript, accountCss } from './owner-ui.js';

export const OWNER_EMAIL = '777docmax777@gmail.com';
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('base64url');
export const ownerOrigin = () => new URL(config.PUBLIC_API_URL ?? (config.RENDER_EXTERNAL_HOSTNAME ? `https://${config.RENDER_EXTERNAL_HOSTNAME}` : 'http://localhost:4000')).origin;
type Session = { token_hash: string; google_sub: string; verified: boolean; enrollment_encrypted: string | null };
declare module 'fastify' { interface FastifyRequest { ownerSession?: Session } }
export function validOwner(payload: TokenPayload | undefined, nonce: string): boolean {
  return !!payload && payload.email_verified === true && payload.email?.toLowerCase() === OWNER_EMAIL && !!payload.sub && (payload as TokenPayload & { nonce?: string }).nonce === nonce;
}
export function totpStep(secret: string, token: string, last: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(token)) return null;
  const delta = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).validate({ token, window: 1, timestamp: now });
  if (delta === null) return null;
  const step = Math.floor(now / 30000) + delta;
  return step > last ? step : null;
}
const publicPaths = new Set(['/health', '/webhooks/telegram', '/account/login', '/account/app.js', '/account/style.css', '/auth/owner/start', '/auth/owner/callback', '/auth/owner/me', '/auth/owner/enroll', '/auth/owner/verify', '/auth/owner/logout']);

export async function installOwnerAuth(app: FastifyInstance) {
  const origin = ownerOrigin();
  const key = process.env.AUTH_SECRET ?? '';
  const id = process.env.GOOGLE_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;
  const callback = `${origin}/auth/owner/callback`;
  const secure = origin.startsWith('https://');
  const cookieName = secure ? '__Host-studio' : 'studio';
  const cookie = (value: string, age: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const browserCookie = (value: string, age: number) => `studio_login=${value}; Path=/auth/owner; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const getCookie = (request: FastifyRequest, name: string) => request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
  const ready = () => !!(key.length >= 32 && id && secret && (secure || config.NODE_ENV !== 'production'));
  app.decorateRequest('ownerSession', undefined);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (path === '/health' || (path === '/webhooks/telegram' && request.method === 'POST')) return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin').header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin) return reply.code(403).send({ error: 'Недійсне джерело запиту. Відкрийте кабінет заново.' });
    try {
      const token = getCookie(request, cookieName);
      if (ready() && token && /^[\w-]{43}$/.test(token)) {
        const result = await requirePool().query('SELECT s.* FROM studio_sessions s JOIN studio_owner o ON o.id=1 WHERE s.token_hash=$1 AND s.expires_at>NOW() AND (o.google_sub IS NULL OR o.google_sub=s.google_sub)', [digest(token)]);
        request.ownerSession = result.rows[0];
      }
    } catch { return reply.code(503).send({ error: 'Перевірка доступу тимчасово недоступна.' }); }
    if (publicPaths.has(path)) return;
    if (!request.ownerSession?.verified) {
      if (request.method === 'GET' && request.headers.accept?.includes('text/html')) return reply.redirect('/account/login');
      return reply.code(401).send({ error: 'Потрібен вхід Google і підтвердження Authenticator.' });
    }
  });

  app.get('/account/style.css', async (_req, reply) => reply.type('text/css').send(accountCss));
  app.get('/account/app.js', async (_req, reply) => reply.type('application/javascript').send(accountScript));
  app.get('/account/login', async (_req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    return reply.type('text/html').send(accountPage);
  });
  app.get('/account', async (_req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    return reply.type('text/html').send(accountPage);
  });
  app.get('/auth/owner/me', async (request) => {
    if (!request.ownerSession) return { stage: 'google', configured: ready() };
    const result = await requirePool().query('SELECT totp_encrypted FROM studio_owner WHERE id=1');
    return { stage: request.ownerSession.verified ? 'ready' : result.rows[0]?.totp_encrypted ? 'totp' : 'enroll', email: OWNER_EMAIL };
  });
  app.get('/auth/owner/start', { logLevel: 'silent' }, async (_request, reply) => {
    if (!ready()) return reply.code(503).send({ error: 'Додайте AUTH_SECRET у Render та налаштуйте Google OAuth.' });
    const state = random(), browser = random(), verifier = random(), nonce = random();
    const db = requirePool();
    await db.query('DELETE FROM studio_login_states WHERE expires_at<NOW()');
    await db.query('DELETE FROM studio_sessions WHERE expires_at<NOW()');
    await db.query("INSERT INTO studio_login_states VALUES($1,$2,$3,$4,NOW()+INTERVAL '10 minutes')", [digest(state), digest(browser), seal(verifier, key), nonce]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: id!, redirect_uri: callback, response_type: 'code', scope: 'openid email', prompt: 'select_account', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return reply.header('Set-Cookie', browserCookie(browser, 600)).redirect(url.toString());
  });
  app.get('/auth/owner/callback', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer').header('Set-Cookie', browserCookie('', 0));
    const query = z.object({ state: z.string().regex(/^[\w-]{43}$/), code: z.string().min(1).max(4096) }).safeParse(request.query);
    const browser = getCookie(request, 'studio_login');
    if (!ready() || !query.success || !browser) return reply.code(400).send({ error: 'Почніть вхід заново.' });
    try {
      const state = (await requirePool().query('DELETE FROM studio_login_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>NOW() RETURNING *', [digest(query.data.state), digest(browser)])).rows[0];
      if (!state) throw new Error('Expired');
      const client = new OAuth2Client(id, secret, callback);
      const { tokens } = await client.getToken({ code: query.data.code, codeVerifier: unseal(state.verifier_encrypted, key) });
      if (!tokens.id_token) throw new Error('Missing identity');
      const payload = (await client.verifyIdToken({ idToken: tokens.id_token, audience: id })).getPayload();
      if (!validOwner(payload, state.nonce)) return reply.code(403).send({ error: 'Цей кабінет доступний лише власнику студії.' });
      const owner = (await requirePool().query('SELECT google_sub FROM studio_owner WHERE id=1')).rows[0];
      if (owner?.google_sub && owner.google_sub !== payload!.sub) throw new Error('Wrong owner');
      const token = random();
      await requirePool().query("INSERT INTO studio_sessions(token_hash,google_sub,expires_at) VALUES($1,$2,NOW()+INTERVAL '10 minutes')", [digest(token), payload!.sub]);
      return reply.header('Set-Cookie', [browserCookie('', 0), cookie(token, 600)]).redirect('/account/login');
    } catch { return reply.code(403).send({ error: 'Не вдалося підтвердити Google-вхід. Спробуйте заново.' }); }
  });
  app.post('/auth/owner/enroll', { logLevel: 'silent', bodyLimit: 2048 }, async (request, reply) => {
    if (!request.ownerSession || request.ownerSession.verified) return reply.code(401).send({ error: 'Спочатку увійдіть через Google.' });
    const body = z.object({ bootstrap: z.string().max(512) }).safeParse(request.body);
    if (!body.success || !setupSecretMatches(body.data.bootstrap, process.env.YOUTUBE_SETUP_SECRET ?? '')) return reply.code(403).send({ error: 'Для першого налаштування потрібен YOUTUBE_SETUP_SECRET.' });
    const owner = (await requirePool().query('SELECT totp_encrypted FROM studio_owner WHERE id=1')).rows[0];
    if (owner?.totp_encrypted) return reply.code(409).send({ error: 'Authenticator уже налаштований.' });
    const totp = new TOTP({ issuer: 'Veil of Ages', label: OWNER_EMAIL, secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
    await requirePool().query('UPDATE studio_sessions SET enrollment_encrypted=$2 WHERE token_hash=$1 AND verified=FALSE', [request.ownerSession.token_hash, seal(totp.secret.base32, key)]);
    return { qr: await QRCode.toDataURL(totp.toString()), secret: totp.secret.base32 };
  });
  app.post('/auth/owner/verify', { logLevel: 'silent', bodyLimit: 2048 }, async (request, reply) => {
    if (!request.ownerSession || request.ownerSession.verified) return reply.code(401).send({ error: 'Почніть вхід заново.' });
    const body = z.object({ code: z.string().trim().min(6).max(64) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Введіть код.' });
    const db = await requirePool().connect();
    try {
      await db.query('BEGIN');
      const owner = (await db.query('SELECT * FROM studio_owner WHERE id=1 FOR UPDATE')).rows[0];
      const session = (await db.query('SELECT * FROM studio_sessions WHERE token_hash=$1 AND expires_at>NOW() AND verified=FALSE FOR UPDATE', [request.ownerSession.token_hash])).rows[0];
      if (!session || (owner.google_sub && owner.google_sub !== session.google_sub)) throw new Error('Invalid session');
      if (owner.locked_until && new Date(owner.locked_until).getTime() > Date.now()) { await db.query('ROLLBACK'); return reply.code(429).send({ error: 'Забагато спроб. Зачекайте 10 хвилин.' }); }
      const enrollment = !owner.totp_encrypted;
      const encrypted = owner.totp_encrypted || session.enrollment_encrypted;
      if (!encrypted) throw new Error('Enroll first');
      const code = body.data.code;
      const step = totpStep(unseal(encrypted, key), code, Number(owner.last_step));
      const recovery = owner.recovery_hashes as string[];
      const recoveryHash = digest(code.toLowerCase());
      const recoveryValid = !enrollment && recovery.includes(recoveryHash);
      if (step === null && !recoveryValid) {
        await db.query("UPDATE studio_owner SET failures=CASE WHEN locked_until<NOW() THEN 1 ELSE failures+1 END, locked_until=CASE WHEN (CASE WHEN locked_until<NOW() THEN 1 ELSE failures+1 END)>=5 THEN NOW()+INTERVAL '10 minutes' ELSE NULL END WHERE id=1");
        await db.query('COMMIT'); return reply.code(403).send({ error: 'Код неправильний, прострочений або вже використаний.' });
      }
      const codes = enrollment ? Array.from({ length: 8 }, () => randomBytes(16).toString('hex')) : [];
      await db.query('UPDATE studio_owner SET google_sub=$1,totp_encrypted=$2,last_step=$3,recovery_hashes=$4,failures=0,locked_until=NULL WHERE id=1', [session.google_sub, encrypted, step ?? owner.last_step, JSON.stringify(enrollment ? codes.map(digest) : recovery.filter(h => h !== recoveryHash))]);
      if (enrollment) await db.query('DELETE FROM studio_sessions');
      else await db.query('DELETE FROM studio_sessions WHERE token_hash=$1', [session.token_hash]);
      const token = random();
      await db.query("INSERT INTO studio_sessions(token_hash,google_sub,verified,expires_at) VALUES($1,$2,TRUE,NOW()+INTERVAL '8 hours')", [digest(token), session.google_sub]);
      await db.query('COMMIT');
      return reply.header('Set-Cookie', cookie(token, 8 * 3600)).send({ ok: true, recoveryCodes: codes });
    } catch { await db.query('ROLLBACK'); return reply.code(400).send({ error: 'Не вдалося завершити вхід. Почніть заново.' }); }
    finally { db.release(); }
  });
  app.post('/auth/owner/logout', async (request, reply) => {
    if (request.ownerSession) await requirePool().query('DELETE FROM studio_sessions WHERE token_hash=$1', [request.ownerSession.token_hash]);
    return reply.header('Set-Cookie', cookie('', 0)).send({ ok: true });
  });
  app.post('/account/logout-all', async (_request, reply) => {
    await requirePool().query('DELETE FROM studio_sessions');
    return reply.header('Set-Cookie', cookie('', 0)).send({ ok: true });
  });
}
