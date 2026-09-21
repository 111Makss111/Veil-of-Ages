import { config as loadEnv } from 'dotenv';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { hostname, cpus, totalmem, tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildVideoLyricTrack, transcribeVideoLyrics, type VideoLyricCue } from './video-lyrics.js';
import { checkMediaTools, renderMedia, runMediaTool } from './media-render.js';
import type { FactoryEffectId, MotionIntensity } from './factory-effects.js';
import type { CinematicPreset } from './media-render.js';

const projectRoot=fileURLToPath(new URL('../../../',import.meta.url));
const workerEnvPath=process.env.VEIL_WORKER_ENV?resolve(process.cwd(),process.env.VEIL_WORKER_ENV):join(projectRoot,'.env.local-worker');
loadEnv({path:workerEnvPath});

const jobSchema=z.object({id:z.string().uuid(),lease:z.string().uuid(),title:z.string(),audio:z.object({id:z.string(),type:z.string(),duration:z.number(),url:z.string().url()}),scenes:z.array(z.object({position:z.number(),label:z.string(),type:z.string(),url:z.string().url()})).min(1).max(3),output:z.object({id:z.string(),type:z.literal('video/mp4'),url:z.string().url()}),lyrics:z.string(),preset:z.enum(['ancient-mist','ember-glow','moonlit-ruins']),intensity:z.enum(['calm','cinematic','expressive']),effects:z.array(z.string()),lyricVideo:z.unknown().nullable()});
type Job=z.infer<typeof jobSchema>;

const apiUrl=String(process.env.VEIL_API_URL||'').replace(/\/+$/,''),workerSecret=String(process.env.LOCAL_WORKER_SECRET||'');
const workerId=String(process.env.LOCAL_WORKER_ID||hostname()).replace(/[^a-zA-Z0-9._-]/g,'-').slice(0,70),workerName=String(process.env.LOCAL_WORKER_NAME||`${hostname()} · RTX монтаж`).slice(0,100);
if(!/^https?:\/\//.test(apiUrl)||workerSecret.length<32)throw new Error('Set VEIL_API_URL and LOCAL_WORKER_SECRET (32+ characters) in the local environment.');

async function locate(name:'ffmpeg'|'ffprobe'){
  const configured=process.env[name==='ffmpeg'?'FFMPEG_PATH':'FFPROBE_PATH'];if(configured){await access(configured);return configured;}
  const executable=process.platform==='win32'?name+'.exe':name,root=resolve(projectRoot,'.tools','ffmpeg');
  const walk=async(directory:string,depth:number):Promise<string|null>=>{if(depth<0)return null;for(const item of await readdir(directory,{withFileTypes:true}).catch(()=>[])){const path=join(directory,item.name);if(item.isFile()&&item.name.toLowerCase()===executable)return path;if(item.isDirectory()){const found=await walk(path,depth-1);if(found)return found;}}return null;};
  return await walk(root,4)||executable;
}

async function request(path:string,body:unknown){
  const response=await fetch(apiUrl+path,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${workerSecret}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({error:'Server returned an unreadable response'})) as any;if(!response.ok)throw new Error(String(data.error||`HTTP ${response.status}`));return data;
}
const capabilities=()=>({gpu:'NVIDIA RTX / NVENC',cpuThreads:cpus().length,memoryGb:Math.round(totalmem()/1024/1024/1024),lyricSync:!!process.env.OPENAI_API_KEY,encoder:process.env.LOCAL_VIDEO_ENCODER||'libx264',version:1});
const heartbeat=(busy=false,releaseId:string|null=null)=>request('/api/local-worker/heartbeat',{workerId,name:workerName,capabilities:capabilities(),busy,releaseId});
const report=(job:Job,stage:string,progress:number,detail:string,seconds?:number,duration?:number)=>request(`/api/local-worker/jobs/${job.id}/progress`,{lease:job.lease,workerId,stage,progress:Math.round(progress),detail,...(seconds===undefined?{}:{seconds}),...(duration===undefined?{}:{duration})});

async function download(url:string,path:string){
  const response=await fetch(url,{redirect:'error'});if(!response.ok||!response.body)throw new Error('R2 did not provide an input file.');
  await pipeline(Readable.fromWeb(response.body as any),createWriteStream(path,{flags:'wx'}));
}
async function upload(url:string,path:string){
  const size=(await stat(path)).size,response=await fetch(url,{method:'PUT',redirect:'error',headers:{'Content-Type':'video/mp4','Content-Length':String(size)},body:createReadStream(path) as any,duplex:'half'} as any);
  if(!response.ok){await response.body?.cancel();throw new Error('R2 did not confirm the finished video upload.');}
}
function restoredCues(value:unknown):VideoLyricCue[]{
  const data=(value&&typeof value==='object'&&Array.isArray((value as any).cues))?(value as any).cues:[];
  return data.filter((cue:any)=>Number.isFinite(cue?.start)&&Number.isFinite(cue?.end)&&typeof cue?.text==='string'&&typeof cue?.accent==='string'&&['verse','chorus','bridge'].includes(cue?.emphasis)&&['upper','center','lower'].includes(cue?.position)).slice(0,150);
}

async function work(job:Job){
  const directory=await mkdtemp(join(tmpdir(),'veil-local-worker-')),controller=new AbortController();let lastProgress=0;
  try{
    await heartbeat(true,job.id);await report(job,'local-downloading',27,'ПК отримує музику та образи безпосередньо зі сховища.');
    const audioExt=job.audio.type==='audio/wav'?'.wav':'.mp3',audio=join(directory,'song'+audioExt),output=join(directory,'video.mp4');
    await download(job.audio.url,audio);
    const images:string[]=[];for(const [index,scene] of job.scenes.sort((a,b)=>a.position-b.position).entries()){const path=join(directory,`scene-${index}${extname(new URL(scene.url).pathname)||'.jpg'}`);await download(scene.url,path);images.push(path);}
    let cues=restoredCues(job.lyricVideo);
    if(!cues.length){
      await report(job,'local-transcribing',32,'Синхронізуємо слова з вокалом для lyric video.');
      if(!process.env.OPENAI_API_KEY)throw new Error('На локальному ПК не задано OPENAI_API_KEY для синхронізації слів.');
      const speech=join(directory,'lyrics-audio.mp3');
      await runMediaTool(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-i',audio,'-vn','-ac','1','-ar','16000','-b:a','64k',speech],10*60*1000,controller.signal);
      cues=await transcribeVideoLyrics(speech,job.lyrics,job.audio.duration,controller.signal)||[];
      if(cues.length<4)throw new Error('Не вдалося надійно розпізнати вокал. Відео без синхронізованих слів не створюємо.');
    }
    await report(job,'local-graphics',39,`Готуємо ${cues.length} динамічних текстових фраз.`);
    const lyricTrack=await buildVideoLyricTrack(directory,cues,job.audio.duration,(done,total)=>{if(done===total||done%10===0)void report(job,'local-graphics',39+done/total*8,`Підготовлено ${done} із ${total} текстових фраз.`).catch(()=>controller.abort());});
    if(!lyricTrack)throw new Error('Не вдалося створити текстовий шар.');
    const allowed=new Set(['story.three-scenes','camera.center-push','atmosphere.moving-mist','atmosphere.drifting-particles','look.dark-fantasy-grade','light.global-breathing','texture.film-grain','framing.vignette','transition.scene-crossfades','transition.soft-fades','audio.loudness-master']);
    const effects=[...new Set([...job.effects,'camera.center-push','light.global-breathing','look.dark-fantasy-grade','framing.vignette','transition.soft-fades','audio.loudness-master'])].filter(value=>allowed.has(value)) as FactoryEffectId[];
    await report(job,'local-rendering',48,'Локальний ПК монтує фон, рух і синхронізований текст.');
    await renderMedia(images,audio,output,job.audio.type==='audio/wav'?'wav':'mp3',controller.signal,'video',job.preset as CinematicPreset,p=>{const now=Date.now();if(now-lastProgress<1800&&p.percent<100)return;lastProgress=now;void report(job,'local-rendering',48+p.percent*.44,`Змонтовано ${Math.floor(p.seconds/60)}:${String(Math.floor(p.seconds%60)).padStart(2,'0')} із ${Math.floor(p.duration/60)}:${String(Math.floor(p.duration%60)).padStart(2,'0')}.`,p.seconds,p.duration).catch(()=>controller.abort());},job.intensity as MotionIntensity,effects,[],lyricTrack);
    await report(job,'local-uploading',94,'Перевірку завершено. Повертаємо готове відео у приватне сховище.');await upload(job.output.url,output);
    await request(`/api/local-worker/jobs/${job.id}/complete`,{lease:job.lease,workerId,cues});
  }catch(error){
    const message=error instanceof Error?error.message:'Локальний монтаж не завершено.';
    await request(`/api/local-worker/jobs/${job.id}/fail`,{lease:job.lease,workerId,error:message.slice(0,300)}).catch(()=>{});
  }finally{controller.abort();await rm(directory,{recursive:true,force:true});await heartbeat(false,null).catch(()=>{});}
}

async function main(){
  process.env.FFMPEG_PATH=await locate('ffmpeg');process.env.FFPROBE_PATH=await locate('ffprobe');process.env.MEDIA_THREADS=process.env.MEDIA_THREADS||String(Math.min(8,Math.max(2,cpus().length-2)));
  await checkMediaTools();
  if((process.env.LOCAL_VIDEO_ENCODER||'auto')==='auto'){
    try{await runMediaTool(process.env.FFMPEG_PATH,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=64x64:d=0.1','-c:v','h264_nvenc','-f','null',process.platform==='win32'?'NUL':'/dev/null'],15000);process.env.LOCAL_VIDEO_ENCODER='h264_nvenc';}
    catch{process.env.LOCAL_VIDEO_ENCODER='libx264';}
  }
  await mkdir(resolve(process.cwd(),'exports'),{recursive:true});
  console.log(`Veil of Ages local worker is ready: ${workerName}`);
  while(true){
    try{const result=await request('/api/local-worker/claim',{workerId,name:workerName,capabilities:capabilities()}),job=result.job?jobSchema.parse(result.job):null;if(job)await work(job);else{await heartbeat(false,null);await new Promise(resolve=>setTimeout(resolve,12_000));}}
    catch(error){console.error(error instanceof Error?error.message:'Worker connection failed');await new Promise(resolve=>setTimeout(resolve,20_000));}
  }
}

void main();
