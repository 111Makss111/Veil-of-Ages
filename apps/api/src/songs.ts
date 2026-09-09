import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePool } from './db.js';
import { ownerOrigin } from './owner-auth.js';
import { profileSchema } from './songs-domain.js';
import { SongError, decideVersion, expireRuns, finishRun, startRun } from './songs-store.js';
import { generateSong, generatorConfig } from './songs-provider.js';
import { songsPage, songsCss, songsScript } from './songs-ui.js';

const idSchema = z.object({ id: z.uuid() });
const dailyLimit = () => {
  const value = Number(process.env.SONG_DAILY_LIMIT ?? 10);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 10;
};
export async function songsRoutes(app: FastifyInstance) {
  const tasks = new Set<Promise<void>>();
  const shutdown = new AbortController();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin')
      .header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!request.ownerSession?.verified) return reply.code(401).send({ error: 'Увійдіть у кабінет та підтвердьте Authenticator.' });
    if (request.method === 'POST' && request.headers.origin !== ownerOrigin()) return reply.code(403).send({ error: 'Відкрийте проєкт зі свого кабінету.' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof SongError ? error.status : error instanceof z.ZodError ? 400 : 503;
    reply.code(status).send({ error: error instanceof SongError ? error.message : status === 400 ? 'Перевірте заповнені поля.' : 'Сховище проєктів тимчасово недоступне. Спробуйте оновити сторінку.' });
  });
  app.addHook('onClose', async () => { shutdown.abort(); await Promise.allSettled([...tasks]); });
  app.get('/songs', async (_req, reply) => reply.type('text/html').send(songsPage));
  app.get('/songs/style.css', async (_req, reply) => reply.type('text/css').send(songsCss));
  app.get('/songs/app.js', async (_req, reply) => reply.type('application/javascript').send(songsScript));
  app.get('/api/songs/config', async () => ({ ...generatorConfig(), dailyLimit: dailyLimit() }));
  app.get('/api/songs/profiles', async () => ({ profiles: (await requirePool().query('SELECT * FROM song_profiles ORDER BY id')).rows }));
  app.post('/api/songs/profiles/:id', { bodyLimit: 10000, logLevel: 'silent' }, async request => {
    const { id } = z.object({ id: z.enum(['pirate', 'viking']) }).parse(request.params);
    const { revision, settings } = z.object({ revision: z.number().int().positive(), settings: profileSchema }).strict().parse(request.body);
    const result = await requirePool().query('UPDATE song_profiles SET settings=$2,revision=revision+1 WHERE id=$1 AND revision=$3 RETURNING *', [id, JSON.stringify(settings), revision]);
    if (!result.rowCount) throw new SongError(409, 'Стиль змінився в іншій вкладці. Оновіть сторінку перед збереженням.');
    return result.rows[0];
  });
  app.get('/api/songs/projects', async request => {
    await expireRuns();
    const { offset } = z.object({ offset: z.coerce.number().int().min(0).max(1000000).default(0) }).parse(request.query);
    const result = await requirePool().query(`SELECT p.*, s.settings->>'name' AS profile_name,
      (SELECT COUNT(*)::int FROM song_versions v WHERE v.project_id=p.id) AS versions,
      (SELECT state FROM song_runs r WHERE r.project_id=p.id ORDER BY r.created_at DESC LIMIT 1) AS last_state
      FROM song_projects p JOIN song_profiles s ON s.id=p.profile_id ORDER BY p.created_at DESC,p.id LIMIT 21 OFFSET $1`, [offset]);
    return { projects: result.rows.slice(0,20), hasMore: result.rows.length > 20 };
  });
  app.post('/api/songs/projects', { bodyLimit: 10000, logLevel: 'silent' }, async request => {
    const data = z.object({ id: z.uuid(), name: z.string().trim().min(3).max(100), profileId: z.enum(['pirate','viking']), brief: z.string().trim().min(20).max(3000) }).strict().parse(request.body);
    await requirePool().query('INSERT INTO song_projects(id,name,profile_id,brief) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [data.id,data.name,data.profileId,data.brief]);
    const saved = (await requirePool().query('SELECT * FROM song_projects WHERE id=$1', [data.id])).rows[0];
    if (saved.name !== data.name || saved.profile_id !== data.profileId || saved.brief !== data.brief) throw new SongError(409, 'Ідентифікатор уже використаний іншим проєктом.');
    return saved;
  });
  app.get('/api/songs/projects/:id', async request => {
    const { id } = idSchema.parse(request.params);
    await expireRuns();
    const project = (await requirePool().query('SELECT * FROM song_projects WHERE id=$1', [id])).rows[0];
    if (!project) throw new SongError(404, 'Проєкт не знайдено.');
    const versions = (await requirePool().query('SELECT v.*,r.model,r.snapshot FROM song_versions v LEFT JOIN song_runs r ON r.id=v.run_id WHERE v.project_id=$1 ORDER BY v.created_at DESC', [id])).rows;
    const runs = (await requirePool().query('SELECT id,request_key,state,error,model,created_at,finished_at FROM song_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20', [id])).rows;
    return { project, versions, runs };
  });
  app.post('/api/songs/projects/:id/generate', { bodyLimit: 2048, logLevel: 'silent' }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const { requestKey } = z.object({ requestKey: z.uuid() }).strict().parse(request.body);
    const config = generatorConfig();
    if (!config.configured) throw new SongError(503, 'Для генерації додайте OPENAI_API_KEY у Render. Проєкт і стиль уже можна зберегти.');
    const { run, fresh } = await startRun(id, requestKey, config.model, dailyLimit());
    if (fresh) {
      const task = (async () => {
        try {
          const result = await generateSong(run.prompt, AbortSignal.any([shutdown.signal, AbortSignal.timeout(90000)]));
          await finishRun(run.id, result.song, result.inputTokens, result.outputTokens);
        } catch (error) {
          // Raw provider responses and database errors are never sent to the browser.
          const message = error instanceof Error && /^(Додайте|Ключ|Генератор|Генерацію)/.test(error.message) ? error.message : 'Результат не підтверджено. Запит міг бути оплачений; автоматичного повтору немає.';
          await requirePool().query("UPDATE song_runs SET state='uncertain',error=$2,finished_at=NOW() WHERE id=$1 AND state='running'", [run.id, message]).catch(() => {});
        }
      })();
      tasks.add(task); void task.finally(() => tasks.delete(task));
    }
    return reply.code(fresh ? 202 : 200).send({ id: run.id, state: run.state, reused: !fresh });
  });
  app.post('/api/songs/projects/:id/decision', { bodyLimit: 2048, logLevel: 'silent' }, async request => {
    const { id } = idSchema.parse(request.params);
    const body = z.object({ versionId: z.uuid(), decision: z.enum(['approved','rejected']) }).strict().parse(request.body);
    await decideVersion(id, body.versionId, body.decision);
    return { ok: true };
  });
}
