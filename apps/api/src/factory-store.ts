import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { requirePool } from './db.js';
import { INPUT_LIMIT, STORAGE_LIMIT, type ObjectStore } from './factory-storage.js';
import { MAX_OUTPUT_BYTES } from './media-render.js';
import type { CinematicPreset } from './media-render.js';
import { buildReleaseConcept, MAX_GENERATED_IMAGE_BYTES } from './factory-ai.js';

export const factoryMigration = `
CREATE TABLE IF NOT EXISTS factory_assets (
 id UUID PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('audio','image','video')),
 hash TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, bytes BIGINT NOT NULL CHECK(bytes>0),
 type TEXT NOT NULL, duration DOUBLE PRECISION, theme TEXT NOT NULL DEFAULT '',
 vocal TEXT NOT NULL CHECK(vocal IN ('instrumental','choir')),
 state TEXT NOT NULL CHECK(state IN ('reserved','ready','uncertain')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(kind,hash)
);
CREATE TABLE IF NOT EXISTS factory_recipe (
 id INTEGER PRIMARY KEY CHECK(id=1), vocal TEXT NOT NULL DEFAULT 'instrumental' CHECK(vocal IN ('instrumental','choir')),
 cover_id UUID REFERENCES factory_assets(id), visual_preset TEXT NOT NULL DEFAULT 'auto', revision INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE factory_recipe ADD COLUMN IF NOT EXISTS visual_preset TEXT NOT NULL DEFAULT 'auto';
INSERT INTO factory_recipe(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS factory_releases (
 id UUID PRIMARY KEY, request_key UUID UNIQUE NOT NULL, track_id UUID NOT NULL UNIQUE REFERENCES factory_assets(id),
 cover_id UUID NOT NULL REFERENCES factory_assets(id), output_id UUID NOT NULL REFERENCES factory_assets(id),
 title TEXT NOT NULL, recipe JSONB NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('rendering','review','failed','publishing','private','uncertain')),
 error TEXT, video_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE factory_releases ALTER COLUMN cover_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS factory_one_render ON factory_releases((true)) WHERE state='rendering';
`;
export class FactoryError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function factoryLock<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await requirePool().connect();
  try { await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(28092026)'); const result = await fn(db); await db.query('COMMIT'); return result; }
  catch(e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
export async function capacity(db: Pick<PoolClient,'query'>, storage: ObjectStore, bytes: number, input = false) {
  const actual = await storage.usage();
  const pending = Number((await db.query("SELECT COALESCE(SUM(bytes),0) AS bytes FROM factory_assets WHERE state<>'ready'")).rows[0].bytes);
  if (actual + pending + bytes > (input ? INPUT_LIMIT : STORAGE_LIMIT)) throw new FactoryError(409, input ? 'Запас для нових матеріалів вичерпано. Залишаємо 2 ГБ для результатів. Нічого автоматично не видаляємо.' : 'Досягнуто ліміт фабрики 8 ГБ. Звільнення місця потребує твого рішення.');
  return { actual, pending };
}
export async function reserveAsset(storage: ObjectStore, data: { kind: 'audio'|'image'; hash: string; name: string; bytes: number; type: string; duration: number|null; theme: string; vocal: string }) {
  return factoryLock(async db => {
    const existing = (await db.query('SELECT * FROM factory_assets WHERE kind=$1 AND hash=$2',[data.kind,data.hash])).rows[0];
    if (existing) return { asset: existing, fresh: false };
    await capacity(db, storage, data.bytes, true);
    const id = randomUUID();
    const asset = (await db.query(`INSERT INTO factory_assets(id,kind,hash,object_key,name,bytes,type,duration,theme,vocal,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved') RETURNING *`,[id,data.kind,data.hash,'factory/'+id,data.name,data.bytes,data.type,data.duration,data.theme,data.vocal])).rows[0];
    return { asset, fresh: true };
  });
}
export function chooseVisualPreset(value: string, trackHash: string, theme = ''): CinematicPreset {
  if (value === 'ancient-mist' || value === 'ember-glow' || value === 'moonlit-ruins') return value;
  const text = theme.toLowerCase();
  if (/fire|flame|ember|tavern|candle|вог|жар|свіч/.test(text)) return 'ember-glow';
  if (/moon|night|ruin|ice|winter|ніч|місяц|руїн|зим/.test(text)) return 'moonlit-ruins';
  return parseInt(trackHash.slice(0, 2), 16) % 3 === 0 ? 'ember-glow' : parseInt(trackHash.slice(0, 2), 16) % 3 === 1 ? 'moonlit-ruins' : 'ancient-mist';
}
export async function startRelease(storage: ObjectStore, requestKey: string, generateImage = false) {
  return factoryLock(async db => {
    const existing = (await db.query('SELECT * FROM factory_releases WHERE request_key=$1',[requestKey])).rows[0];
    if (existing) return { release: existing, fresh: false };
    if ((await db.query("SELECT id FROM factory_releases WHERE state='rendering'")).rowCount) throw new FactoryError(409,'Лінія вже збирає випуск. Дочекайся завершення.');
    const recipe = (await db.query('SELECT * FROM factory_recipe WHERE id=1')).rows[0];
    const track = (await db.query(`SELECT a.* FROM factory_assets a WHERE kind='audio' AND state='ready' AND vocal=$1
      AND NOT EXISTS(SELECT 1 FROM factory_releases r WHERE r.track_id=a.id) ORDER BY created_at,id LIMIT 1`,[recipe.vocal])).rows[0];
    if (!track) throw new FactoryError(409,'Немає невикористаних треків з обраним режимом вокалу. Поповни бібліотеку або зміни режим.');
    let concept:ReturnType<typeof buildReleaseConcept>|null=null;
    let cover = generateImage ? null : (await db.query("SELECT id FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[recipe.cover_id])).rows[0];
    if(!generateImage&&!cover)throw new FactoryError(409,'Підключи Workers AI або додай резервну обкладинку.');
    await capacity(db, storage, MAX_OUTPUT_BYTES+(generateImage?MAX_GENERATED_IMAGE_BYTES:0));
    const id=randomUUID(), outputId=randomUUID();
    if(generateImage){
      const used=new Set((await db.query("SELECT recipe->>'conceptHash' AS hash FROM factory_releases WHERE recipe->>'conceptHash' IS NOT NULL")).rows.map(r=>r.hash));
      for(let attempt=0;attempt<128;attempt++){const candidate=buildReleaseConcept(track.hash,attempt);if(!used.has(candidate.hash)){concept=candidate;break;}}
      if(!concept)throw new FactoryError(409,'Не вдалося підібрати нову сцену. Розширимо каталог концепцій.');
      const coverId=randomUUID();
      cover=(await db.query("INSERT INTO factory_assets(id,kind,hash,object_key,name,bytes,type,vocal,state,theme) VALUES($1,'image',$2,$3,$4,$5,'image/jpeg',$6,'reserved',$7) RETURNING id",[coverId,'ai:'+concept.hash,'factory/'+coverId,concept.title+'.jpg',MAX_GENERATED_IMAGE_BYTES,recipe.vocal,concept.scene])).rows[0];
    }
    await db.query("INSERT INTO factory_assets(id,kind,hash,object_key,name,bytes,type,vocal,state) VALUES($1,'video',$2,$3,$4,$5,'video/mp4',$6,'reserved')",[outputId,id,'factory/'+outputId,'Випуск.mp4',MAX_OUTPUT_BYTES,recipe.vocal]);
    const title=concept?.title??track.name.replace(/\.[^.]+$/,'').replace(/[<>\x00-\x1f]/g,'').slice(0,75)+' | Dark Fantasy Ambient';
    const visualPreset=chooseVisualPreset(recipe.visual_preset,track.hash,track.theme);
    const release=(await db.query("INSERT INTO factory_releases(id,request_key,track_id,cover_id,output_id,title,recipe,state) VALUES($1,$2,$3,$4,$5,$6,$7,'rendering') RETURNING *",[id,requestKey,track.id,cover.id,outputId,title.slice(0,100),JSON.stringify({genre:'Dark Fantasy / Medieval Ambient',vocal:recipe.vocal,revision:recipe.revision,theme:track.theme,visualPreset,coverMode:generateImage?'ai':'manual',conceptHash:concept?.hash,prompt:concept?.prompt,seed:concept?.seed,scene:concept?.scene})])).rows[0];
    return { release, fresh: true };
  });
}
