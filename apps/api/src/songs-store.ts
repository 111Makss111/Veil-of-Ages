import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { requirePool } from './db.js';
import { compareSong, composePrompt, lyricHash, PROMPT_VERSION, seedProfiles, type Profile, type Song, type Match } from './songs-domain.js';

export const songsMigration = `
CREATE TABLE IF NOT EXISTS song_profiles(id TEXT PRIMARY KEY, settings JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS song_projects(id UUID PRIMARY KEY, name TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES song_profiles(id), brief TEXT NOT NULL, approved_version UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS song_runs(id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES song_projects(id), request_key UUID UNIQUE NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','complete','failed','uncertain')), snapshot JSONB NOT NULL, prompt TEXT NOT NULL, model TEXT NOT NULL, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ);
CREATE UNIQUE INDEX IF NOT EXISTS song_one_running ON song_runs ((state)) WHERE state='running';
CREATE TABLE IF NOT EXISTS song_versions(id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES song_projects(id), run_id UUID UNIQUE REFERENCES song_runs(id), content JSONB NOT NULL, lyric_hash TEXT NOT NULL, matches JSONB NOT NULL DEFAULT '[]', decision TEXT NOT NULL DEFAULT 'review' CHECK(decision IN ('review','approved','rejected')), input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS song_versions_project ON song_versions(project_id,created_at);
`;
export class SongError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function seedSongs(db = requirePool()) {
  for (const [id, profile] of Object.entries(seedProfiles)) await db.query('INSERT INTO song_profiles(id,settings) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, JSON.stringify(profile)]);
}
async function transaction<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await requirePool().connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
export async function expireRuns(db: pg.Pool | pg.PoolClient = requirePool()) {
  await db.query("UPDATE song_runs SET state='uncertain',error='Запуск перервався або перевищив час. Він міг бути оплачений. Автоматичного повтору немає.',finished_at=NOW() WHERE state='running' AND created_at<NOW()-INTERVAL '5 minutes'");
}
export async function startRun(projectId: string, requestKey: string, model: string, dailyLimit: number) {
  return transaction(async db => {
    // Serializes claims across API instances without keeping a transaction open during generation.
    await db.query('SELECT pg_advisory_xact_lock(19092026)');
    await expireRuns(db);
    const existing = (await db.query('SELECT * FROM song_runs WHERE request_key=$1', [requestKey])).rows[0];
    if (existing) {
      if (existing.project_id !== projectId) throw new SongError(409, 'Цей ключ запуску належить іншому проєкту.');
      return { run: existing, fresh: false };
    }
    const project = (await db.query('SELECT p.*,s.settings,s.revision FROM song_projects p JOIN song_profiles s ON s.id=p.profile_id WHERE p.id=$1 FOR UPDATE OF p', [projectId])).rows[0];
    if (!project) throw new SongError(404, 'Проєкт не знайдено.');
    if (project.approved_version) throw new SongError(409, 'Проєкт уже затверджено. Створіть новий проєкт для іншої пісні.');
    if ((await db.query("SELECT id FROM song_runs WHERE state='running'")).rowCount) throw new SongError(409, 'Уже працює генерація. Дочекайтеся результату.');
    const count = (await db.query("SELECT COUNT(*)::int AS n FROM song_runs WHERE created_at>NOW()-INTERVAL '24 hours'")).rows[0].n;
    if (count >= dailyLimit) throw new SongError(429, 'Досягнуто ліміту запусків за останні 24 години.');
    const previous = (await db.query("SELECT content->>'title' AS title,content->>'concept' AS concept FROM song_versions ORDER BY created_at DESC LIMIT 30")).rows;
    const prompt = composePrompt(project.settings as Profile, project.brief, previous);
    const snapshot = { profile: project.settings, profileRevision: project.revision, brief: project.brief, promptVersion: PROMPT_VERSION };
    const run = (await db.query("INSERT INTO song_runs(id,project_id,request_key,state,snapshot,prompt,model) VALUES($1,$2,$3,'running',$4,$5,$6) RETURNING *", [randomUUID(), projectId, requestKey, JSON.stringify(snapshot), prompt, model])).rows[0];
    return { run, fresh: true };
  });
}
export async function finishRun(runId: string, song: Song, inputTokens: number, outputTokens: number) {
  return transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(19092026)');
    const run = (await db.query("SELECT * FROM song_runs WHERE id=$1 AND state='running' FOR UPDATE", [runId])).rows[0];
    if (!run) return;
    // Every retained version, including rejected drafts, is checked in bounded pages.
    let cursor = '00000000-0000-0000-0000-000000000000';
    const matches: Match[] = [];
    while (true) {
      const page = (await db.query('SELECT id,project_id,content FROM song_versions WHERE id>$1::uuid ORDER BY id LIMIT 100', [cursor])).rows;
      for (const row of page) {
        const match = compareSong(song, { ...row.content, id: row.id, project_id: row.project_id });
        if (match) matches.push(match);
      }
      matches.sort((a,b) => b.score-a.score); matches.splice(10);
      if (page.length < 100) break;
      cursor = page[page.length - 1].id;
    }
    await db.query('INSERT INTO song_versions(id,project_id,run_id,content,lyric_hash,matches,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), run.project_id, run.id, JSON.stringify(song), lyricHash(song.lyrics), JSON.stringify(matches), inputTokens, outputTokens]);
    await db.query("UPDATE song_runs SET state='complete',finished_at=NOW() WHERE id=$1", [run.id]);
  });
}
export async function decideVersion(projectId: string, versionId: string, decision: 'approved' | 'rejected') {
  await transaction(async db => {
    const project = (await db.query('SELECT id FROM song_projects WHERE id=$1 FOR UPDATE', [projectId])).rows[0];
    if (!project) throw new SongError(404, 'Проєкт не знайдено.');
    if ((await db.query("SELECT id FROM song_runs WHERE project_id=$1 AND state='running'", [projectId])).rowCount) throw new SongError(409, 'Дочекайтеся завершення генерації.');
    const version = (await db.query('SELECT * FROM song_versions WHERE id=$1 AND project_id=$2', [versionId, projectId])).rows[0];
    if (!version) throw new SongError(404, 'Версію не знайдено.');
    if (decision === 'approved' && version.matches.length) throw new SongError(409, 'Виявлено повтор: створіть нову версію перед затвердженням.');
    if (decision === 'approved') {
      await db.query("UPDATE song_versions SET decision='review' WHERE project_id=$1 AND decision='approved'", [projectId]);
      await db.query('UPDATE song_projects SET approved_version=$2 WHERE id=$1', [projectId, versionId]);
    } else await db.query('UPDATE song_projects SET approved_version=NULL WHERE id=$1 AND approved_version=$2', [projectId, versionId]);
    await db.query('UPDATE song_versions SET decision=$2 WHERE id=$1', [versionId, decision]);
  });
}
