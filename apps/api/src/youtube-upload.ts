import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { requirePool } from './db.js';
import { getYoutubeRefreshToken, googleToken, requireVeilOfAgesChannel, setupSecretMatches, YoutubeChannelMismatchError } from './youtube.js';

export const MAX_VIDEO_BYTES = 48 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const metadataSchema = z.object({
  title: z.string().trim().min(1).max(100).regex(/^[^<>\u0000-\u001f]+$/),
  children: z.enum(['yes', 'no']), synthetic: z.enum(['yes', 'no']),
  description: z.string().trim().max(5000).default('Original music release from Veil of Ages.'),
  tags: z.string().trim().max(500).default('').transform(value => value.split(',').map(tag => tag.trim()).filter(Boolean).slice(0,15))
});
export type Metadata = {
  title: string;
  children: 'yes'|'no';
  synthetic: 'yes'|'no';
  description?: string;
  tags?: string[];
};

export class YoutubeUploadOutcomeError extends Error {
  constructor(message:string,public readonly uncertain:boolean){super(message);this.name='YoutubeUploadOutcomeError';}
}

export function isMp4(file: Buffer): boolean {
  return file.length >= 12 && file.toString('ascii', 4, 8) === 'ftyp';
}

function uploadLocation(value:string|null):URL {
  const location=new URL(value??'https://invalid.invalid');
  if(location.protocol!=='https:'||location.hostname!=='www.googleapis.com'||location.port||location.username||location.password||location.pathname!=='/upload/youtube/v3/videos')throw new Error('Invalid upload destination');
  return location;
}

async function confirmedVideo(response:Response):Promise<string>{
  const video=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{11}$/),status:z.object({privacyStatus:z.literal('private')})}).parse(await response.json());
  return video.id;
}

function nextUploadByte(response:Response,total:number):number{
  const match=/bytes=0-(\d+)/.exec(response.headers.get('range')??'');
  return match?Math.min(total,Number(match[1])+1):0;
}

async function queryUpload(location:URL,total:number,authorization:string):Promise<Response>{
  return fetch(location,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:authorization,'Content-Length':'0','Content-Range':`bytes */${total}`}});
}

async function finishPrivateVideo(file:Buffer,location:URL,authorization:string):Promise<string>{
  let offset=0,lastError:unknown;
  for(let attempt=0;attempt<4;attempt++){
    let response:Response;
    try{
      if(offset>=file.length)response=await queryUpload(location,file.length,authorization);
      else{const body=file.subarray(offset);response=await fetch(location,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(180000),headers:{Authorization:authorization,'Content-Type':'video/mp4','Content-Length':String(body.length),'Content-Range':`bytes ${offset}-${file.length-1}/${file.length}`},body:new Uint8Array(body)});}
    }catch(error){
      lastError=error;
      try{response=await queryUpload(location,file.length,authorization);}catch(statusError){lastError=statusError;continue;}
    }
    if(response.ok)return confirmedVideo(response);
    if(response.status===308){offset=nextUploadByte(response,file.length);continue;}
    throw new Error('Upload outcome not confirmed');
  }
  throw lastError instanceof Error?lastError:new Error('Upload outcome not confirmed');
}

async function finishPrivateVideoFile(path:string,total:number,location:URL,authorization:string):Promise<string>{
  let offset=0,lastError:unknown;
  for(let attempt=0;attempt<4;attempt++){
    let response:Response;
    try{
      if(offset>=total)response=await queryUpload(location,total,authorization);
      else{
        const body=createReadStream(path,{start:offset});
        const init={method:'PUT',redirect:'error',signal:AbortSignal.timeout(5*60*1000),headers:{Authorization:authorization,'Content-Type':'video/mp4','Content-Length':String(total-offset),'Content-Range':`bytes ${offset}-${total-1}/${total}`},body:body as unknown as BodyInit,duplex:'half'} as unknown as RequestInit&{duplex:'half'};
        response=await fetch(location,init);
      }
    }catch(error){
      lastError=error;
      try{response=await queryUpload(location,total,authorization);}catch(statusError){lastError=statusError;continue;}
    }
    if(response.ok)return confirmedVideo(response);
    if(response.status===308){offset=nextUploadByte(response,total);continue;}
    throw new Error('Upload outcome not confirmed');
  }
  throw lastError instanceof Error?lastError:new Error('Upload outcome not confirmed');
}

async function createUploadSession(total:number,metadata:Metadata,accessToken:string):Promise<{location:URL;authorization:string}>{
  const authorization=`Bearer ${accessToken}`;
  const session=await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:authorization,'Content-Type':'application/json','X-Upload-Content-Type':'video/mp4','X-Upload-Content-Length':String(total)},
    body:JSON.stringify({snippet:{title:metadata.title,categoryId:'10',description:metadata.description||'Original music release from Veil of Ages.',tags:metadata.tags??[]},status:{privacyStatus:'private',selfDeclaredMadeForKids:metadata.children==='yes',containsSyntheticMedia:metadata.synthetic==='yes'}})
  });
  if(!session.ok)throw new Error('YouTube refused upload session');
  return {location:uploadLocation(session.headers.get('location')),authorization};
}

export async function sendPrivateVideo(file: Buffer, metadata: Metadata, accessToken: string): Promise<string> {
  const session=await createUploadSession(file.length,metadata,accessToken);
  return finishPrivateVideo(file,session.location,session.authorization);
}

export async function sendPrivateVideoFile(path:string,metadata:Metadata,accessToken:string):Promise<string>{
  const size=(await stat(path)).size;
  const session=await createUploadSession(size,metadata,accessToken);
  return finishPrivateVideoFile(path,size,session.location,session.authorization);
}

export async function uploadPrivateVideoFile(path:string,metadata:Metadata):Promise<{videoId:string;duplicate:boolean}>{
  const size=(await stat(path)).size;
  if(size<12||size>MAX_VIDEO_BYTES)throw new YoutubeUploadOutcomeError('Готове відео має неправильний розмір.',false);
  const handle=await open(path,'r');
  try{const header=Buffer.alloc(12);await handle.read(header,0,12,0);if(!isMp4(header))throw new YoutubeUploadOutcomeError('Готовий файл не є MP4.',false);}
  finally{await handle.close();}
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk as Buffer);const fileHash=hash.digest('hex');
  const refresh=await getYoutubeRefreshToken();if(!refresh)throw new YoutubeUploadOutcomeError('Спочатку підключіть YouTube через Google.',false);
  const token=await googleToken({client_id:process.env.YOUTUBE_CLIENT_ID??'',client_secret:process.env.YOUTUBE_CLIENT_SECRET??'',refresh_token:refresh,grant_type:'refresh_token'});
  try{await requireVeilOfAgesChannel(token.access_token);}catch(error){throw new YoutubeUploadOutcomeError(error instanceof YoutubeChannelMismatchError?error.message:'Не вдалося перевірити канал YouTube.',false);}
  const db=requirePool();let claimed=false;
  try{
    const inserted=await db.query("INSERT INTO youtube_uploads(file_hash,state) VALUES($1,'uploading') ON CONFLICT DO NOTHING RETURNING file_hash",[fileHash]);
    if(!inserted.rows.length){
      const previous=await db.query('SELECT state,video_id FROM youtube_uploads WHERE file_hash=$1',[fileHash]);
      if(previous.rows[0]?.state==='complete')return {videoId:previous.rows[0].video_id,duplicate:true};
      throw new YoutubeUploadOutcomeError('Результат попередньої передачі невідомий. Спочатку перевір YouTube Studio.',true);
    }
    claimed=true;
    const videoId=await sendPrivateVideoFile(path,metadata,token.access_token);
    await db.query("UPDATE youtube_uploads SET state='complete',video_id=$2 WHERE file_hash=$1",[fileHash,videoId]);
    return {videoId,duplicate:false};
  }catch(error){
    if(claimed)await db.query("UPDATE youtube_uploads SET state='uncertain' WHERE file_hash=$1 AND state='uploading'",[fileHash]).catch(()=>{});
    if(error instanceof YoutubeUploadOutcomeError)throw error;
    throw new YoutubeUploadOutcomeError(claimed?'Передачу не підтверджено. Перевір YouTube Studio.':'Не вдалося отримати доступ до Google або бази.',claimed);
  }
}

type ThumbnailFailure='forbidden'|'invalid'|'not-found'|'rate-limit'|'temporary';
export class YoutubeThumbnailError extends Error {
  constructor(public readonly reason:ThumbnailFailure,message:string){super(message);this.name='YoutubeThumbnailError';}
}

const thumbnailFailure=(status:number,reason?:string)=>{
  if(status===403)return new YoutubeThumbnailError('forbidden','YouTube не дозволив API встановити обкладинку для цього відео. Якщо власні значки вже ввімкнені, перевір, що до фабрики підключено саме канал Veil of Ages, зачекай 10–30 хвилин після активації функції та повтори лише встановлення обкладинки. Відео вже збережене приватно.');
  if(status===400)return new YoutubeThumbnailError('invalid','YouTube відхилив файл обкладинки. Фабрика збере її заново під час повторної спроби.');
  if(status===404||reason==='videoNotFound')return new YoutubeThumbnailError('not-found','YouTube ще не бачить щойно завантажене відео. Зачекай хвилину й повтори встановлення обкладинки.');
  if(status===429||reason==='uploadRateLimitExceeded')return new YoutubeThumbnailError('rate-limit','YouTube тимчасово обмежив кількість обкладинок. Повтори спробу пізніше.');
  return new YoutubeThumbnailError('temporary','YouTube тимчасово не підтвердив обкладинку. Відео вже збережене приватно; повтори лише встановлення обкладинки.');
};

export async function setVideoThumbnail(file: Buffer, type: 'image/jpeg'|'image/png', videoId: string, accessToken: string, wait:(ms:number)=>Promise<unknown>=(ms)=>new Promise(resolve=>setTimeout(resolve,ms))): Promise<void> {
  if (file.length < 16 || file.length > MAX_THUMBNAIL_BYTES) throw new YoutubeThumbnailError('invalid','Обкладинка має бути до 2 МіБ.');
  const url=new URL('https://www.googleapis.com/upload/youtube/v3/thumbnails/set');url.searchParams.set('videoId',videoId);url.searchParams.set('uploadType','media');
  let lastError:YoutubeThumbnailError|undefined;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':type,'Content-Length':String(file.length)},body:new Uint8Array(file)});
      if(response.ok)return;
      const body=await response.json().catch(()=>null) as {error?:{errors?:Array<{reason?:string}>}}|null;
      lastError=thumbnailFailure(response.status,body?.error?.errors?.[0]?.reason);
      if(lastError.reason!=='not-found'&&lastError.reason!=='temporary')throw lastError;
    }catch(error){
      if(error instanceof YoutubeThumbnailError){lastError=error;if(error.reason!=='not-found'&&error.reason!=='temporary')throw error;}
      else lastError=thumbnailFailure(503);
    }
    if(attempt<2)await wait((attempt+1)*1500);
  }
  throw lastError??thumbnailFailure(503);
}

export type YoutubeVideoState='processed'|'processing'|'failed'|'missing';
export async function getYoutubeVideoState(videoId:string,accessToken:string):Promise<{state:YoutubeVideoState;detail:string}>{
  const url=new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search=new URLSearchParams({part:'status,processingDetails',id:videoId}).toString();
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${accessToken}`}});
  if(response.status===401||response.status===403)throw new Error('Підключення Google не має дозволу перевіряти приватні ролики. Онови підключення YouTube й надай новий дозвіл на перегляд.');
  if(!response.ok)throw new Error('YouTube video status unavailable');
  const data=z.object({items:z.array(z.object({
    status:z.object({uploadStatus:z.string().optional(),failureReason:z.string().optional(),rejectionReason:z.string().optional()}).optional(),
    processingDetails:z.object({processingStatus:z.string().optional(),processingFailureReason:z.string().optional()}).optional()
  }).passthrough())}).parse(await response.json());
  const video=data.items[0];
  if(!video)return {state:'missing',detail:'YouTube не знайшов ролик за збереженим ID.'};
  const upload=video.status?.uploadStatus,processing=video.processingDetails?.processingStatus;
  if(upload==='failed'||upload==='rejected'||upload==='deleted'||processing==='failed'||processing==='terminated')return {state:'failed',detail:'YouTube отримав файл, але не завершив його обробку.'};
  if(upload==='processed'||processing==='succeeded')return {state:'processed',detail:'YouTube підтвердив ролик і завершив його обробку.'};
  return {state:'processing',detail:'Ролик є на YouTube, але його обробка ще триває.'};
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
  for(const type of ['image/jpeg','image/png'])app.addContentTypeParser(type,{parseAs:'buffer',bodyLimit:MAX_THUMBNAIL_BYTES},(_req,body,done)=>done(null,body));
  app.get('/youtube/upload', async (_req, reply) => reply.type('text/html').send(html));
  app.get('/youtube/upload.css', async (_req, reply) => reply.type('text/css').send(css));
  app.get('/youtube/upload.js', async (_req, reply) => reply.type('application/javascript').send(script));
  app.post('/youtube/thumbnail',{bodyLimit:MAX_THUMBNAIL_BYTES,logLevel:'silent',onRequest:async(request,reply)=>{
    if(!request.ownerSession?.verified)return reply.code(401).send({error:'Потрібно увійти у кабінет.'});
    if(request.headers.origin!==origin)return reply.code(403).send({error:'Відкрийте фабрику на адресі Render заново.'});
  }},async(request,reply)=>{
    const query=z.object({videoId:z.string().regex(/^[A-Za-z0-9_-]{11}$/)}).safeParse(request.query);
    const type=request.headers['content-type'];const file=request.body;
    if(!query.success||!Buffer.isBuffer(file)||(type!=='image/jpeg'&&type!=='image/png'))return reply.code(400).send({error:'Мініатюра має бути PNG або JPG до 2 МіБ.'});
    const valid=type==='image/png'?file.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):file[0]===0xff&&file[1]===0xd8;
    if(!valid)return reply.code(400).send({error:'Формат мініатюри не підтверджено.'});
    try{const refresh=await getYoutubeRefreshToken();if(!refresh)return reply.code(409).send({error:'Спочатку підключіть YouTube через Google.'});const token=await googleToken({client_id:process.env.YOUTUBE_CLIENT_ID??'',client_secret:process.env.YOUTUBE_CLIENT_SECRET??'',refresh_token:refresh,grant_type:'refresh_token'});await requireVeilOfAgesChannel(token.access_token);await setVideoThumbnail(file,type,query.data.videoId,token.access_token);return {ok:true};}
    catch(error){return reply.code(error instanceof YoutubeChannelMismatchError||error instanceof YoutubeThumbnailError&&error.reason!=='temporary'?409:502).send({error:error instanceof YoutubeChannelMismatchError||error instanceof YoutubeThumbnailError?error.message:'Відео завантажено, але YouTube не підтвердив власну обкладинку.'});}
  });
  app.post('/youtube/video-status',{logLevel:'silent',onRequest:async(request,reply)=>{
    if(!request.ownerSession?.verified)return reply.code(401).send({error:'Потрібно увійти у кабінет.'});
    if(request.headers.origin!==origin)return reply.code(403).send({error:'Відкрийте фабрику на адресі Render заново.'});
  }},async(request,reply)=>{
    const query=z.object({videoId:z.string().regex(/^[A-Za-z0-9_-]{11}$/)}).safeParse(request.query);
    if(!query.success)return reply.code(400).send({error:'Некоректний ID ролика.'});
    try{const refresh=await getYoutubeRefreshToken();if(!refresh)return reply.code(409).send({error:'Спочатку підключіть YouTube через Google.'});const token=await googleToken({client_id:process.env.YOUTUBE_CLIENT_ID??'',client_secret:process.env.YOUTUBE_CLIENT_SECRET??'',refresh_token:refresh,grant_type:'refresh_token'});await requireVeilOfAgesChannel(token.access_token);return await getYoutubeVideoState(query.data.videoId,token.access_token);}
    catch(error){return reply.code(error instanceof YoutubeChannelMismatchError?409:502).send({error:error instanceof YoutubeChannelMismatchError||error instanceof Error&&error.message.startsWith('Підключення Google')?error.message:'Не вдалося перевірити ролик через YouTube API. Онови підключення Google і спробуй ще раз.'});}
  });
  app.post('/youtube/upload', {
    bodyLimit: MAX_VIDEO_BYTES, logLevel: 'silent',
    onRequest: async (request, reply) => {
      const secret = request.headers['x-setup-secret'];
      if (!request.ownerSession?.verified && (typeof secret !== 'string' || !setupSecretMatches(secret, process.env.YOUTUBE_SETUP_SECRET ?? ''))) return reply.code(401).send({ error: 'Потрібно увійти у кабінет.' });
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
      try{await requireVeilOfAgesChannel(token.access_token);}catch(error){if(error instanceof YoutubeChannelMismatchError)return reply.code(409).send({error:error.message});throw error;}
      const db = requirePool();
      const inserted = await db.query("INSERT INTO youtube_uploads(file_hash,state) VALUES($1,'uploading') ON CONFLICT DO NOTHING RETURNING file_hash", [fileHash]);
      if (!inserted.rows.length) {
        const previous = await db.query('SELECT state,video_id FROM youtube_uploads WHERE file_hash=$1', [fileHash]);
        if (previous.rows[0]?.state === 'complete') return { videoId: previous.rows[0].video_id, duplicate: true };
        return reply.code(409).send({ error: 'Цей файл уже передається або результат попередньої спроби невідомий. Перевірте YouTube Studio; автоматичний повтор заблокований, щоб не створити копію.', uncertain: true });
      }
      claimed = true;
      const videoId = await sendPrivateVideo(request.body, metadata.data, token.access_token);
      await db.query("UPDATE youtube_uploads SET state='complete',video_id=$2 WHERE file_hash=$1", [fileHash, videoId]);
      return { videoId, duplicate: false };
    } catch {
      if (claimed) await requirePool().query("UPDATE youtube_uploads SET state='uncertain' WHERE file_hash=$1 AND state='uploading'", [fileHash]).catch(() => {});
      return reply.code(502).send({ error: claimed ? 'Не вдалося підтвердити завантаження. Перевірте YouTube Studio перед наступними діями; дублікат автоматично не створюватиметься.' : 'Не вдалося отримати доступ до Google або бази. Оновіть статус YouTube; за потреби підключіть Google заново.', uncertain: claimed });
    }
  });
}
