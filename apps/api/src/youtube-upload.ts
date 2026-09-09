import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { requirePool } from './db.js';
import { getYoutubeRefreshToken, googleToken, setupSecretMatches } from './youtube.js';

export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const metadataSchema = z.object({
  title: z.string().trim().min(1).max(100).regex(/^[^<>\u0000-\u001f]+$/),
  children: z.enum(['yes', 'no']), synthetic: z.enum(['yes', 'no'])
});
type Metadata = z.infer<typeof metadataSchema>;

export function isMp4(file: Buffer): boolean {
  return file.length >= 12 && file.toString('ascii', 4, 8) === 'ftyp';
}

export async function sendPrivateVideo(file: Buffer, metadata: Metadata, accessToken: string): Promise<string> {
  const authorization = `Bearer ${accessToken}`;
  const session = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(file.length) },
    body: JSON.stringify({ snippet: { title: metadata.title, categoryId: '10', description: 'Тестове завантаження через Veil of Ages.' }, status: { privacyStatus: 'private', selfDeclaredMadeForKids: metadata.children === 'yes', containsSyntheticMedia: metadata.synthetic === 'yes' } })
  });
  if (!session.ok) throw new Error('YouTube refused upload session');
  const location = new URL(session.headers.get('location') ?? 'https://invalid.invalid');
  if (location.protocol !== 'https:' || location.hostname !== 'www.googleapis.com' || location.port || location.username || location.password || location.pathname !== '/upload/youtube/v3/videos') throw new Error('Invalid upload destination');
  const result = await fetch(location, {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { Authorization: authorization, 'Content-Type': 'video/mp4', 'Content-Length': String(file.length) },
    body: new Uint8Array(file)
  });
  if (!result.ok) throw new Error('Upload outcome not confirmed');
  const video = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{11}$/), status: z.object({ privacyStatus: z.literal('private') }) }).parse(await result.json());
  return video.id;
}

const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Завантаження YouTube · Veil of Ages</title><link rel="stylesheet" href="/youtube/upload.css"><script src="/youtube/upload.js" defer></script></head><body><main><p>VEIL OF AGES</p><h1>Тестове відео на YouTube</h1><p>Файл буде завантажено в канал підключеного Google-акаунта лише як <strong>приватне відео</strong>, без сповіщення підписників. Перевірте обраний канал під час авторизації.</p><form id="upload"><label>Секрет налаштування Render (YOUTUBE_SETUP_SECRET)<input id="secret" type="password" required autocomplete="off"></label><label>Назва ролика<input id="title" maxlength="100" value="Veil of Ages — тестове відео" required></label><label>Відео MP4 (до 25 МіБ)<input id="file" type="file" accept="video/mp4,.mp4" required></label><label>Це відео створене спеціально для дітей?<select id="children" required><option value="">Оберіть</option><option value="no">Ні</option><option value="yes">Так</option></select></label><label>Містить музику або інший реалістичний контент, згенерований ШІ?<select id="synthetic" required><option value="">Оберіть</option><option value="yes">Так</option><option value="no">Ні</option></select></label><label><input type="checkbox" required> Підтверджую, що маю право завантажити це аудіо та зображення.</label><button id="submit">Завантажити приватно на YouTube</button></form><p id="status" role="status" aria-live="polite"></p><a id="result" hidden target="_blank" rel="noopener noreferrer">Відкрити відео на YouTube</a><p>Не закривайте сторінку під час передачі. Якщо зв'язок обірветься, спочатку перевірте YouTube Studio. Повторна відправка того самого файлу не створює нову копію.</p><a href="/auth/youtube">Повторно підключити Google</a></main></body></html>`;
const css = `body{background:#0c0e16;color:#eee;font:17px system-ui;margin:0}main{max-width:680px;margin:48px auto;padding:24px}h1{font-size:36px}p{line-height:1.6;color:#b9bdce}label{display:block;margin:20px 0}input:not([type=checkbox]),select{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:8px;background:#191d2b;color:#fff;border:1px solid #454a63;border-radius:8px}button{padding:15px 22px;background:#7565ff;color:white;border:0;border-radius:24px;font:inherit;cursor:pointer}button:disabled{opacity:.5}a{color:#8ae3ff}`;
const script = `const form=document.getElementById('upload'),button=document.getElementById('submit'),status=document.getElementById('status'),link=document.getElementById('result');
form.addEventListener('submit',async(event)=>{event.preventDefault();const file=document.getElementById('file').files[0];if(!file||file.size>26214400||file.size<12){status.textContent='Оберіть MP4 розміром до 25 МіБ.';return;}button.disabled=true;link.hidden=true;status.textContent='Передаємо файл на Render, потім на YouTube. Зачекайте…';
try{const query=new URLSearchParams({title:document.getElementById('title').value,children:document.getElementById('children').value,synthetic:document.getElementById('synthetic').value});const response=await fetch('/youtube/upload?'+query,{method:'POST',headers:{'Content-Type':'video/mp4','X-Setup-Secret':document.getElementById('secret').value},body:file});const data=await response.json();if(!response.ok)throw new Error(data.error||'Запит не завершився. Перевірте YouTube Studio перед повтором.');if(!/^[A-Za-z0-9_-]{11}$/.test(data.videoId))throw new Error('Не вдалося підтвердити результат.');status.textContent=data.duplicate?'Цей файл уже завантажено. Нової копії не створено.':'YouTube прийняв приватне відео. Обробка зображення та звуку може ще тривати.';link.href='https://www.youtube.com/watch?v='+data.videoId;link.hidden=false;}
catch(error){status.textContent=error instanceof Error?error.message:'Зв’язок обірвався. Перевірте YouTube Studio.';}finally{document.getElementById('secret').value='';button.disabled=false;}});`;

export async function youtubeUploadRoutes(app: FastifyInstance) {
  const origin = new URL(config.PUBLIC_API_URL ?? (config.RENDER_EXTERNAL_HOSTNAME ? `https://${config.RENDER_EXTERNAL_HOSTNAME}` : 'http://localhost:4000')).origin;
  let busy = false;
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin')
      .header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  });
  app.addContentTypeParser('video/mp4', { parseAs: 'buffer', bodyLimit: MAX_VIDEO_BYTES }, (_req, body, done) => done(null, body));
  app.get('/youtube/upload', async (_req, reply) => reply.type('text/html').send(html));
  app.get('/youtube/upload.css', async (_req, reply) => reply.type('text/css').send(css));
  app.get('/youtube/upload.js', async (_req, reply) => reply.type('application/javascript').send(script));
  app.post('/youtube/upload', {
    bodyLimit: MAX_VIDEO_BYTES, logLevel: 'silent',
    onRequest: async (request, reply) => {
      const secret = request.headers['x-setup-secret'];
      if (typeof secret !== 'string' || !setupSecretMatches(secret, process.env.YOUTUBE_SETUP_SECRET ?? '')) return reply.code(401).send({ error: 'Неправильний YOUTUBE_SETUP_SECRET.' });
      if (request.headers.origin !== origin) return reply.code(403).send({ error: 'Відкрийте форму на адресі Render заново.' });
      if (busy) return reply.code(429).send({ error: 'Уже передається інше відео. Дочекайтеся завершення.' });
      busy = true;
      let released = false;
      const release = () => { if (!released) { busy = false; released = true; } };
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
    }
  }, async (request, reply) => {
    const metadata = metadataSchema.safeParse(request.query);
    if (!metadata.success || !Buffer.isBuffer(request.body) || !isMp4(request.body)) return reply.code(400).send({ error: 'Перевірте назву, відповіді про контент і формат MP4.' });
    const fileHash = createHash('sha256').update(request.body).digest('hex');
    let claimed = false;
    try {
      const refresh = await getYoutubeRefreshToken();
      if (!refresh) return reply.code(409).send({ error: 'Спочатку підключіть YouTube через Google.' });
      const token = await googleToken({ client_id: process.env.YOUTUBE_CLIENT_ID ?? '', client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? '', refresh_token: refresh, grant_type: 'refresh_token' });
      const db = requirePool();
      const inserted = await db.query("INSERT INTO youtube_uploads(file_hash,state) VALUES($1,'uploading') ON CONFLICT DO NOTHING RETURNING file_hash", [fileHash]);
      if (!inserted.rows.length) {
        const previous = await db.query('SELECT state,video_id FROM youtube_uploads WHERE file_hash=$1', [fileHash]);
        if (previous.rows[0]?.state === 'complete') return { videoId: previous.rows[0].video_id, duplicate: true };
        return reply.code(409).send({ error: 'Цей файл уже передається або результат попередньої спроби невідомий. Перевірте YouTube Studio; автоматичний повтор заблокований, щоб не створити копію.' });
      }
      claimed = true;
      const videoId = await sendPrivateVideo(request.body, metadata.data, token.access_token);
      await db.query("UPDATE youtube_uploads SET state='complete',video_id=$2 WHERE file_hash=$1", [fileHash, videoId]);
      return { videoId, duplicate: false };
    } catch {
      if (claimed) await requirePool().query("UPDATE youtube_uploads SET state='uncertain' WHERE file_hash=$1 AND state='uploading'", [fileHash]).catch(() => {});
      return reply.code(502).send({ error: claimed ? 'Не вдалося підтвердити завантаження. Перевірте YouTube Studio перед наступними діями; дублікат автоматично не створюватиметься.' : 'Не вдалося отримати доступ до Google або бази. Оновіть статус YouTube; за потреби підключіть Google заново.' });
    }
  });
}
