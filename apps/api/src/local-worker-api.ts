import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requirePool } from './db.js';
import { createObjectStore } from './factory-storage.js';
import type { ObjectStore } from './factory-storage.js';
import { FactoryError, factoryLock } from './factory-store.js';
import { MAX_OUTPUT_BYTES } from './media-render.js';

const workerId=z.string().regex(/^[a-zA-Z0-9._-]{3,80}$/);
const uuid=z.string().uuid();
const leaseSchema=z.string().uuid();
const progressSchema=z.object({
  lease:leaseSchema,
  workerId,
  stage:z.enum(['local-downloading','local-transcribing','local-graphics','local-rendering','local-uploading']),
  progress:z.number().int().min(25).max(99),detail:z.string().trim().min(1).max(300),
  seconds:z.number().min(0).max(300).optional(),duration:z.number().min(1).max(300).optional()
}).strict();

const secret=()=>String(process.env.LOCAL_WORKER_SECRET||'');
export const localWorkerConfigured=()=>secret().length>=32;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function sameSecret(value:string|undefined){
  const expected=secret();if(expected.length<32||!value)return false;
  const a=Buffer.from(digest(value)),b=Buffer.from(digest(expected));return a.length===b.length&&timingSafeEqual(a,b);
}
async function workerSeen(id:string,name:string,capabilities:unknown,state:'online'|'busy'='online',releaseId:string|null=null){
  await requirePool().query(`INSERT INTO factory_local_workers(id,name,capabilities,state,current_release_id,last_seen) VALUES($1,$2,$3,$4,$5,NOW())
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,capabilities=EXCLUDED.capabilities,state=EXCLUDED.state,current_release_id=EXCLUDED.current_release_id,last_seen=NOW()`,[id,name,JSON.stringify(capabilities||{}),state,releaseId]);
}

export async function getLocalWorkerSummary(){
  if(!localWorkerConfigured())return {configured:false,online:false,worker:null};
  const row=(await requirePool().query("SELECT id,name,capabilities,state,current_release_id,last_seen FROM factory_local_workers ORDER BY last_seen DESC LIMIT 1")).rows[0]||null;
  const online=!!row&&Date.now()-new Date(row.last_seen).getTime()<90_000;
  return {configured:true,online,worker:row?{...row,state:online?row.state:'offline'}:null};
}

export async function localWorkerRoutes(app:FastifyInstance,options:{storage?:ObjectStore|null}={}){
  const storage=options.storage===undefined?createObjectStore():options.storage;
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    const auth=req.headers.authorization;
    if(!sameSecret(typeof auth==='string'&&auth.startsWith('Bearer ')?auth.slice(7):undefined))return reply.code(401).send({error:'Local worker authentication failed'});
  });
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof FactoryError?error.status:error instanceof z.ZodError?400:503).send({error:error instanceof FactoryError?error.message:error instanceof z.ZodError?'Invalid worker request':'Local worker operation failed'}));

  app.post('/api/local-worker/heartbeat',async req=>{
    const body=z.object({workerId,name:z.string().trim().min(1).max(100),capabilities:z.record(z.string(),z.unknown()).default({}),busy:z.boolean().default(false),releaseId:uuid.nullable().default(null)}).strict().parse(req.body);
    await workerSeen(body.workerId,body.name,body.capabilities,body.busy?'busy':'online',body.releaseId);return {ok:true,serverTime:new Date().toISOString()};
  });

  app.post('/api/local-worker/claim',async req=>{
    if(!storage?.signedGet||!storage.signedPut)throw new FactoryError(503,'R2 signed transfers are not configured');
    const body=z.object({workerId,name:z.string().trim().min(1).max(100),capabilities:z.record(z.string(),z.unknown()).default({})}).strict().parse(req.body);
    const claimed=await factoryLock(async db=>{
      const current=(await db.query(`SELECT * FROM factory_releases WHERE state='rendering' AND (
        stage='waiting-local' OR (stage LIKE 'local-%' AND local_worker_lease_until<NOW())
      ) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!current)return null;
      const lease=randomUUID(),leaseHash=digest(lease);
      const release=(await db.query("UPDATE factory_releases SET stage='local-downloading',progress=GREATEST(progress,25),progress_detail='Локальна монтажна станція забрала завдання.',local_worker_id=$2,local_worker_lease_hash=$3,local_worker_lease_until=NOW()+INTERVAL '10 minutes',local_worker_updated_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",[current.id,body.workerId,leaseHash])).rows[0];
      return {release,lease};
    });
    if(!claimed){await workerSeen(body.workerId,body.name,body.capabilities);return {job:null};}
    const {release,lease}=claimed;
    const track=(await requirePool().query('SELECT id,object_key,type,duration FROM factory_assets WHERE id=$1',[release.track_id])).rows[0];
    const output=(await requirePool().query('SELECT id,object_key FROM factory_assets WHERE id=$1',[release.output_id])).rows[0];
    const scenes=(await requirePool().query(`SELECT s.position,s.label,a.id,a.object_key,a.type FROM factory_release_scenes s JOIN factory_assets a ON a.id=s.asset_id WHERE s.release_id=$1 AND a.state='ready' ORDER BY s.position`,[release.id])).rows;
    if(!track||!output||!scenes.length)throw new FactoryError(409,'Prepared local job is incomplete');
    const ideaId=release.recipe?.ideaId,idea=ideaId?(await requirePool().query('SELECT content FROM factory_song_ideas WHERE id=$1',[ideaId])).rows[0]:null;
    const expires=1200,signedGet=storage.signedGet.bind(storage),signedPut=storage.signedPut.bind(storage);
    const job={
      id:release.id,lease,title:release.title,audio:{id:track.id,type:track.type,duration:Number(track.duration)||0,url:await signedGet(track.object_key,expires)},
      scenes:await Promise.all(scenes.map(async(scene:any)=>({position:Number(scene.position),label:scene.label,type:scene.type,url:await signedGet(scene.object_key,expires)}))),
      output:{id:output.id,type:'video/mp4',url:await signedPut(output.object_key,'video/mp4',expires)},
      lyrics:String(idea?.content?.lyrics||''),preset:release.recipe?.visualPreset||'ancient-mist',intensity:release.recipe?.motionIntensity||'cinematic',
      effects:Array.isArray(release.recipe?.productionPlan?.effects)?release.recipe.productionPlan.effects:[],lyricVideo:release.recipe?.lyricVideo||null
    };
    await workerSeen(body.workerId,body.name,body.capabilities,'busy',release.id);return {job};
  });

  app.post('/api/local-worker/jobs/:id/progress',async req=>{
    const id=uuid.parse((req.params as {id:string}).id),body=progressSchema.parse(req.body),hash=digest(body.lease);
    const row=(await requirePool().query(`UPDATE factory_releases SET stage=$4,progress=GREATEST(progress,$5),progress_detail=$6,
      processed_seconds=COALESCE($7,processed_seconds),render_duration=COALESCE($8,render_duration),local_worker_lease_until=NOW()+INTERVAL '10 minutes',local_worker_updated_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND state='rendering' AND local_worker_id=$2 AND local_worker_lease_hash=$3 RETURNING id`,[id,body.workerId,hash,body.stage,body.progress,body.detail,body.seconds??null,body.duration??null])).rows[0];
    if(!row)throw new FactoryError(409,'Job was cancelled or its lease changed');return {ok:true};
  });

  app.post('/api/local-worker/jobs/:id/complete',async req=>{
    if(!storage?.head)throw new FactoryError(503,'R2 verification is unavailable');
    const id=uuid.parse((req.params as {id:string}).id),body=z.object({lease:leaseSchema,workerId,cues:z.array(z.object({start:z.number(),end:z.number(),text:z.string(),accent:z.string(),emphasis:z.enum(['verse','chorus','bridge']),position:z.enum(['upper','center','lower'])})).max(150).default([])}).strict().parse(req.body),hash=digest(body.lease);
    const release=(await requirePool().query(`SELECT r.output_id,a.object_key FROM factory_releases r JOIN factory_assets a ON a.id=r.output_id WHERE r.id=$1 AND r.state='rendering' AND r.local_worker_id=$2 AND r.local_worker_lease_hash=$3`,[id,body.workerId,hash])).rows[0];
    if(!release)throw new FactoryError(409,'Job was cancelled or its lease changed');
    const result=await storage.head(release.object_key);if(result.bytes<1024||result.bytes>MAX_OUTPUT_BYTES)throw new FactoryError(409,'Uploaded video did not pass the size check');
    await factoryLock(async db=>{
      await db.query("UPDATE factory_assets SET state='ready',bytes=$2,type='video/mp4' WHERE id=$1",[release.output_id,result.bytes]);
      await db.query(`UPDATE factory_releases SET state='review',stage='complete',progress=100,progress_detail='Локальний lyric-монтаж готовий до твоєї перевірки.',error=NULL,
        recipe=jsonb_set(recipe,'{lyricVideo}',$2::jsonb,true),local_worker_lease_hash=NULL,local_worker_lease_until=NULL,local_worker_updated_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND state='rendering'`,[id,JSON.stringify({mode:body.cues.length?'transcribed':'unavailable',cues:body.cues})]);
    });
    await requirePool().query("UPDATE factory_local_workers SET state='online',current_release_id=NULL,last_seen=NOW() WHERE id=$1",[body.workerId]);return {ok:true,bytes:result.bytes};
  });

  app.post('/api/local-worker/jobs/:id/fail',async req=>{
    const id=uuid.parse((req.params as {id:string}).id),body=z.object({lease:leaseSchema,workerId,error:z.string().trim().min(1).max(300)}).strict().parse(req.body),hash=digest(body.lease);
    const row=(await requirePool().query("UPDATE factory_releases SET state='failed',stage='local-failed',progress_detail='Локальний монтаж зупинено.',error=$4,local_worker_lease_hash=NULL,local_worker_lease_until=NULL,local_worker_updated_at=NOW(),updated_at=NOW() WHERE id=$1 AND state='rendering' AND local_worker_id=$2 AND local_worker_lease_hash=$3 RETURNING id",[id,body.workerId,hash,body.error])).rows[0];
    if(!row)throw new FactoryError(409,'Job was cancelled or its lease changed');await requirePool().query("UPDATE factory_local_workers SET state='online',current_release_id=NULL,last_seen=NOW() WHERE id=$1",[body.workerId]);return {ok:true};
  });
}
