import { config as loadEnv } from 'dotenv';
import { access, copyFile, readdir } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot=fileURLToPath(new URL('../../../',import.meta.url));
const localEnv=join(projectRoot,'.env.local');
const localExample=join(projectRoot,'.env.local.example');

async function ensureEnvironment():Promise<boolean>{
  try{await access(localEnv);}
  catch{
    await copyFile(localExample,localEnv);
    console.error('\nСтворено .env.local. Заповни в ньому підключення Neon, R2 та ключі, після чого запусти локальний кабінет ще раз.\n');
    if(process.platform==='win32')spawn('notepad.exe',[localEnv],{detached:true,stdio:'ignore'}).unref();
    return false;
  }
  loadEnv({path:localEnv,override:true,quiet:true});
  const required=['DATABASE_URL','R2_ACCOUNT_ID','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'] as const;
  const missing=required.filter(name=>!String(process.env[name]||'').trim());
  if(missing.length){
    console.error(`\nЛокальний кабінет ще не готовий. Додай у .env.local: ${missing.join(', ')}.\n`);
    return false;
  }
  return true;
}

async function locate(name:'ffmpeg'|'ffprobe'){
  const configured=process.env[name==='ffmpeg'?'FFMPEG_PATH':'FFPROBE_PATH'];
  if(configured){await access(configured);return configured;}
  const executable=process.platform==='win32'?`${name}.exe`:name;
  const root=resolve(projectRoot,'.tools','ffmpeg');
  const walk=async(directory:string,depth:number):Promise<string|null>=>{
    if(depth<0)return null;
    for(const item of await readdir(directory,{withFileTypes:true}).catch(()=>[])){
      const path=join(directory,item.name);
      if(item.isFile()&&item.name.toLowerCase()===executable)return path;
      if(item.isDirectory()){
        const found=await walk(path,depth-1);
        if(found)return found;
      }
    }
    return null;
  };
  return await walk(root,4)||executable;
}

function openBrowser(url:string){
  if(process.env.VEIL_NO_BROWSER==='true')return;
  try{
    if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{detached:true,stdio:'ignore'}).unref();
    else if(process.platform==='darwin')spawn('open',[url],{detached:true,stdio:'ignore'}).unref();
    else spawn('xdg-open',[url],{detached:true,stdio:'ignore'}).unref();
  }catch{}
}

async function waitAndOpen(url:string){
  for(let attempt=0;attempt<120;attempt++){
    try{
      const response=await fetch(`${url}/health`,{signal:AbortSignal.timeout(1000)});
      if(response.ok){openBrowser(`${url}/factory`);return;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  console.error('Кабінет не відповів за 60 секунд. Причина має бути в повідомленні вище.');
}

async function main(){
  if(!await ensureEnvironment())return;
  try{
    const databaseUrl=new URL(process.env.DATABASE_URL!);
    if(['prefer','require','verify-ca'].includes(databaseUrl.searchParams.get('sslmode')||'')){
      databaseUrl.searchParams.set('sslmode','verify-full');
      process.env.DATABASE_URL=databaseUrl.toString();
    }
  }catch{}
  process.env.VEIL_LOCAL_MODE='true';
  process.env.NODE_ENV='development';
  process.env.PORT=process.env.PORT||'4000';
  process.env.PUBLIC_API_URL=`http://localhost:${process.env.PORT}`;
  process.env.WEB_ORIGIN=process.env.PUBLIC_API_URL;
  delete process.env.RENDER_EXTERNAL_HOSTNAME;
  delete process.env.LOCAL_WORKER_SECRET;
  process.env.FFMPEG_PATH=await locate('ffmpeg');
  process.env.FFPROBE_PATH=await locate('ffprobe');
  process.env.MEDIA_THREADS=process.env.MEDIA_THREADS||String(Math.min(8,Math.max(2,cpus().length-2)));

  const {checkMediaTools,runMediaTool}=await import('./media-render.js');
  await checkMediaTools();
  if((process.env.LOCAL_VIDEO_ENCODER||'auto')==='auto'){
    try{
      await runMediaTool(process.env.FFMPEG_PATH,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=64x64:d=0.1','-c:v','h264_nvenc','-f','null',process.platform==='win32'?'NUL':'/dev/null'],15000);
      process.env.LOCAL_VIDEO_ENCODER='h264_nvenc';
    }catch{
      process.env.LOCAL_VIDEO_ENCODER='libx264';
      console.warn('NVENC поки недоступний для цієї збірки FFmpeg. Монтаж безпечно працюватиме на процесорі; для RTX онови драйвер NVIDIA до версії 610.00 або новішої.');
    }
  }

  const url=process.env.PUBLIC_API_URL;
  console.log(`\nVeil of Ages запускається локально · монтаж: ${process.env.LOCAL_VIDEO_ENCODER==='h264_nvenc'?'NVIDIA NVENC':'процесор'} · ${process.env.MEDIA_THREADS} потоків`);
  console.log(`Кабінет: ${url}/factory\n`);
  void waitAndOpen(url);
  await import('./server.js');
}

main().catch(error=>{
  console.error('\nНе вдалося запустити локальний кабінет:',error instanceof Error?error.message:error);
  process.exit(1);
});
