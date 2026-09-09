import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { setupSecretMatches } from './youtube.js';
import { checkMediaTools, mediaKind, renderMedia } from './media-render.js';
import { mediaHtml, mediaScript, mediaCss } from './media-ui.js';

type Job = { directory: string; state: 'processing' | 'ready' | 'error'; error?: string; until: number; controller: AbortController; task?: Promise<void> };
export async function mediaRoutes(app: FastifyInstance) {
  const root = await mkdtemp(join(tmpdir(), 'veil-media-'));
  const jobs = new Map<string, Job>();
  let busy = false;
  const origin = new URL(config.PUBLIC_API_URL ?? (config.RENDER_EXTERNAL_HOSTNAME ? `https://${config.RENDER_EXTERNAL_HOSTNAME}` : 'http://localhost:4000')).origin;
  const cleanup = async (directory: string) => {
    if (!resolve(directory).startsWith(resolve(root) + sep)) throw new Error('Invalid cleanup target');
    await rm(directory, { recursive: true, force: true });
  };
  const sweep = async () => {
    for (const [id, job] of jobs) if (job.state !== 'processing' && job.until < Date.now()) { jobs.delete(id); await cleanup(job.directory); }
  };
  const timer = setInterval(() => { void sweep().catch(() => {}); }, 60000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const job of jobs.values()) job.controller.abort();
    await Promise.allSettled([...jobs.values()].map(j => j.task));
    for (const job of jobs.values()) await cleanup(job.directory);
    // root was created exclusively by this plugin, never supplied by a user.
    await rm(root, { recursive: true, force: true });
  });
  await app.register(multipart, { limits: { files: 2, fields: 0, parts: 2, fileSize: 25 * 1024 * 1024 } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!request.url.startsWith('/media/jobs')) return;
    const secret = request.headers['x-setup-secret'];
    if (!request.ownerSession?.verified && (typeof secret !== 'string' || !setupSecretMatches(secret, process.env.YOUTUBE_SETUP_SECRET ?? ''))) return reply.code(401).send({ error: 'Потрібно увійти у кабінет.' });
    if (request.method === 'POST' && request.headers.origin !== origin) return reply.code(403).send({ error: 'Відкрийте форму на Render заново.' });
  });
  app.get('/media', async (_req, reply) => reply.type('text/html').send(mediaHtml));
  app.get('/media/app.js', async (_req, reply) => reply.type('application/javascript').send(mediaScript));
  app.get('/media/style.css', async (_req, reply) => reply.type('text/css').send(mediaCss));
  app.post('/media/jobs', { logLevel: 'silent' }, async (request, reply) => {
    if (busy) return reply.code(429).send({ error: 'Зараз створюється інше відео. Спробуйте після завершення.' });
    busy = true;
    let directory: string | undefined;
    let accepted = false;
    try {
      await sweep();
      if (jobs.size >= 3) return reply.code(429).send({ error: 'Збережено 3 тестові результати. Вони автоматично звільняться через 30 хвилин.' });
      try { await checkMediaTools(); } catch { return reply.code(503).send({ error: 'На сервері недоступні FFmpeg або ffprobe. Потрібно перевірити середовище Render.' }); }
      directory = await mkdtemp(join(root, 'job-'));
      const files: Record<string, { path: string; kind: string }> = {};
      for await (const part of request.parts()) {
        if (part.type !== 'file' || !['image', 'audio'].includes(part.fieldname) || files[part.fieldname]) throw new Error('Оберіть одну картинку й один аудіофайл.');
        const path = join(directory, part.fieldname);
        await pipeline(part.file, createWriteStream(path, { flags: 'wx' }));
        if (part.file.truncated) throw new Error('Файл перевищує 25 МіБ.');
        const handle = await open(path, 'r');
        const header = Buffer.alloc(16);
        let size: number;
        try { await handle.read(header, 0, 16, 0); size = (await handle.stat()).size; } finally { await handle.close(); }
        if (part.fieldname === 'image' && size > 8 * 1024 * 1024) throw new Error('Картинка має бути не більшою за 8 МіБ.');
        const kind = mediaKind(header, part.fieldname === 'image');
        const named = `${path}.${kind}`;
        await rename(path, named);
        files[part.fieldname] = { path: named, kind };
      }
      if (!files.image || !files.audio) throw new Error('Потрібні картинка й аудіо.');
      const id = randomBytes(24).toString('hex');
      const job: Job = { directory, state: 'processing', until: Date.now() + 30 * 60000, controller: new AbortController() };
      jobs.set(id, job);
      job.task = renderMedia(files.image.path, files.audio.path, join(directory, 'video.mp4'), files.audio.kind, job.controller.signal)
        .then(() => { job.state = 'ready'; })
        .catch(error => { job.state = 'error'; job.error = error instanceof Error ? error.message : 'Помилка створення відео.'; })
        .finally(() => { busy = false; job.until = Date.now() + 30 * 60000; });
      accepted = true;
      return reply.code(202).send({ id, state: 'processing' });
    } catch {
      return reply.code(400).send({ error: 'Перевірте файли: JPG/PNG до 8 МіБ та MP3/WAV до 25 МіБ. Потрібно рівно два файли.' });
    } finally {
      if (!accepted) { busy = false; if (directory) await cleanup(directory); }
    }
  });
  app.get<{ Params: { id: string } }>('/media/jobs/:id', { logLevel: 'silent' }, async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job || job.until < Date.now()) return reply.code(404).send({ error: 'Завдання відсутнє або сервер перезапустився. Створіть ролик заново.' });
    return { state: job.state, error: job.error };
  });
  app.get<{ Params: { id: string } }>('/media/jobs/:id/file', { logLevel: 'silent' }, async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job || job.state !== 'ready' || job.until < Date.now()) return reply.code(404).send({ error: 'Відео ще не готове або термін зберігання минув.' });
    return reply.type('video/mp4').header('Content-Disposition', 'attachment; filename="veil-of-ages.mp4"').send(createReadStream(join(job.directory, 'video.mp4')));
  });
}
