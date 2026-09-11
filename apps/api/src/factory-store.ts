import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { requirePool } from './db.js';
import { INPUT_LIMIT, STORAGE_LIMIT, type ObjectStore } from './factory-storage.js';
import { MAX_OUTPUT_BYTES } from './media-render.js';
import type { CinematicPreset } from './media-render.js';
import { buildReleaseConcept, GENERATED_SCENE_COUNT, MAX_GENERATED_IMAGE_BYTES } from './factory-ai.js';
import { ACTIVE_EFFECT_IDS, motionIntensitySchema, productionPlanSchema } from './factory-effects.js';

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
 cover_id UUID REFERENCES factory_assets(id), visual_preset TEXT NOT NULL DEFAULT 'auto',
 motion_intensity TEXT NOT NULL DEFAULT 'cinematic' CHECK(motion_intensity IN ('calm','cinematic','expressive')), revision INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE factory_recipe ADD COLUMN IF NOT EXISTS visual_preset TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE factory_recipe ADD COLUMN IF NOT EXISTS motion_intensity TEXT NOT NULL DEFAULT 'cinematic';
INSERT INTO factory_recipe(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS factory_releases (
 id UUID PRIMARY KEY, request_key UUID UNIQUE NOT NULL, track_id UUID NOT NULL UNIQUE REFERENCES factory_assets(id),
 cover_id UUID NOT NULL REFERENCES factory_assets(id), output_id UUID NOT NULL REFERENCES factory_assets(id),
 title TEXT NOT NULL, recipe JSONB NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('rendering','review','failed','publishing','private','uncertain')),
 error TEXT, video_id TEXT, progress INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'queued', progress_detail TEXT NOT NULL DEFAULT '',
 started_at TIMESTAMPTZ, render_started_at TIMESTAMPTZ, processed_seconds DOUBLE PRECISION, render_duration DOUBLE PRECISION,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE factory_releases ALTER COLUMN cover_id DROP NOT NULL;
ALTER TABLE factory_releases ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE factory_releases ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE factory_releases ADD COLUMN IF NOT EXISTS progress_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE factory_releases ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE factory_releases ADD COLUMN IF NOT EXISTS render_started_at TIMESTAMPTZ;
ALTER TABLE factory_releases ADD COLUMN IF NOT EXISTS processed_seconds DOUBLE PRECISION;
ALTER TABLE factory_releases ADD COLUMN IF NOT EXISTS render_duration DOUBLE PRECISION;
CREATE UNIQUE INDEX IF NOT EXISTS factory_one_render ON factory_releases((true)) WHERE state='rendering';
CREATE TABLE IF NOT EXISTS factory_release_scenes (
 release_id UUID NOT NULL REFERENCES factory_releases(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position>=0 AND position<3),
 asset_id UUID NOT NULL REFERENCES factory_assets(id),
 label TEXT NOT NULL, prompt TEXT NOT NULL, seed BIGINT NOT NULL,
 PRIMARY KEY(release_id,position)
);
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
    let sceneAssets:Array<{id:string;position:number;label:string;prompt:string;seed:number}>=[];
    let cover = generateImage ? null : (await db.query("SELECT id FROM factory_assets WHERE id=$1 AND kind='image' AND state='ready'",[recipe.cover_id])).rows[0];
    if(!generateImage&&!cover)throw new FactoryError(409,'Підключи Workers AI або додай резервну обкладинку.');
    await capacity(db, storage, MAX_OUTPUT_BYTES+(generateImage?MAX_GENERATED_IMAGE_BYTES*GENERATED_SCENE_COUNT:0));
    const id=randomUUID(), outputId=randomUUID();
    if(generateImage){
      const used=new Set((await db.query("SELECT recipe->>'conceptHash' AS hash FROM factory_releases WHERE recipe->>'conceptHash' IS NOT NULL")).rows.map(r=>r.hash));
      for(let attempt=0;attempt<128;attempt++){const candidate=buildReleaseConcept(track.hash,attempt);if(!used.has(candidate.hash)){concept=candidate;break;}}
      if(!concept)throw new FactoryError(409,'Не вдалося підібрати нову сцену. Розширимо каталог концепцій.');
      for(const [position,scene] of concept.scenes.entries()){
        const sceneId=randomUUID();
        const asset=(await db.query("INSERT INTO factory_assets(id,kind,hash,object_key,name,bytes,type,vocal,state,theme) VALUES($1,'image',$2,$3,$4,$5,'image/jpeg',$6,'reserved',$7) RETURNING id",[sceneId,'ai:'+scene.hash,'factory/'+sceneId,`${concept.title} · ${scene.label}.jpg`,MAX_GENERATED_IMAGE_BYTES,recipe.vocal,scene.scene])).rows[0];
        sceneAssets.push({id:asset.id,position,label:scene.label,prompt:scene.prompt,seed:scene.seed});
      }
      cover={id:sceneAssets[0]!.id};
    }else{
      sceneAssets=[{id:cover.id,position:0,label:'Єдина сцена',prompt:'',seed:0}];
    }
    await db.query("INSERT INTO factory_assets(id,kind,hash,object_key,name,bytes,type,vocal,state) VALUES($1,'video',$2,$3,$4,$5,'video/mp4',$6,'reserved')",[outputId,id,'factory/'+outputId,'Випуск.mp4',MAX_OUTPUT_BYTES,recipe.vocal]);
    const title=concept?.title??track.name.replace(/\.[^.]+$/,'').replace(/[<>\x00-\x1f]/g,'').slice(0,75)+' | Dark Fantasy Ambient';
    const visualPreset=chooseVisualPreset('auto',track.hash,track.theme);
    const motionIntensity=motionIntensitySchema.parse(recipe.motion_intensity||'cinematic');
    const sceneCount=generateImage?3:1;
    const effects=sceneCount===3?ACTIVE_EFFECT_IDS:ACTIVE_EFFECT_IDS.filter(id=>id!=='story.three-scenes'&&id!=='transition.scene-crossfades');
    const productionPlan=productionPlanSchema.parse({version:2,source:'baseline-rules',sceneCount,visualPreset,motionIntensity,effects,approvalRequired:true});
    const release=(await db.query("INSERT INTO factory_releases(id,request_key,track_id,cover_id,output_id,title,recipe,state,progress,stage,progress_detail,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,'rendering',2,'preparing','Резервуємо місце та готуємо виробничу лінію.',NOW()) RETURNING *",[id,requestKey,track.id,cover.id,outputId,title.slice(0,100),JSON.stringify({genre:'Dark Fantasy / Medieval Ambient',vocal:recipe.vocal,revision:recipe.revision,theme:track.theme,visualPreset,motionIntensity,productionPlan,coverMode:generateImage?'ai':'manual',conceptHash:concept?.hash,prompt:concept?.prompt,seed:concept?.seed,scene:concept?.scene,scenes:concept?.scenes})])).rows[0];
    for(const scene of sceneAssets)await db.query('INSERT INTO factory_release_scenes(release_id,position,asset_id,label,prompt,seed) VALUES($1,$2,$3,$4,$5,$6)',[id,scene.position,scene.id,scene.label,scene.prompt,scene.seed]);
    return { release, fresh: true };
  });
}
