import { createHash } from 'node:crypto';
import { mediaKind } from './media-render.js';

export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;
export type ReleaseConcept = { hash: string; title: string; prompt: string; seed: number; scene: string };
export type ImageGenerator = (prompt: string, seed: number, signal?: AbortSignal) => Promise<{ data: Buffer; type: 'image/jpeg'|'image/png' }>;

const places = ['a drowned abbey','a ruined mountain citadel','an ancient forest chapel','a forgotten royal library','a black-stone monastery','a silent village beneath a cliff','a crumbling bridge over an endless gorge','a lonely keep beside a frozen lake'];
const subjects = ['a solitary hooded traveller','an abandoned throne','a weathered knight without heraldry','a mysterious original sorceress','a procession of distant lanterns','a spectral stag','an empty boat at the shore','a colossal ancient bell'];
const weather = ['slow rolling mist','fine rain crossing the frame','silent snowfall','wind carrying pale ash','low storm clouds','cold haze after rain','drifting smoke from unseen fires','moonlit fog'];
const light = ['muted moonlight and faint emerald fire','dim candlelight against deep green shadows','a cold blue dawn with muted gold reflections','distant lightning behind slate clouds','soft firelight reflected on wet stone','a narrow beam of pale sunlight through clouds'];
const compositions = ['wide cinematic establishing shot','low-angle cinematic composition','layered landscape with strong foreground silhouettes','symmetrical gothic composition with deep perspective','distant panoramic view with atmospheric depth','intimate medium-wide scene framed by ruined arches'];

const pick = <T>(items: T[], byte: number):T => items[byte % items.length]!;
export function buildReleaseConcept(trackHash: string, attempt = 0): ReleaseConcept {
  const digest = createHash('sha256').update(trackHash+':'+attempt).digest();
  const byte=(index:number)=>digest[index]??0;
  const place=pick(places,byte(0)),subject=pick(subjects,byte(1)),climate=pick(weather,byte(2)),lighting=pick(light,byte(3)),composition=pick(compositions,byte(4));
  const placeTitle=place.replace(/^(a|an|the) /,'').split(' ').map(v=>v.charAt(0).toUpperCase()+v.slice(1)).join(' ');
  const titlePrefixes=['Echoes of','Beneath','Beyond','The Silence of','Dreams Beneath','Lament for'];
  const title=pick(titlePrefixes,byte(5))+' '+placeTitle;
  const scene=`${place}; ${subject}; ${climate}; ${lighting}; ${composition}`;
  const prompt=`Create an original 16:9 cinematic cover for a Dark Fantasy / Medieval Ambient music release. Scene: ${scene}. Forest green, slate, charcoal and muted antique gold palette. Epic but quiet, melancholic, mysterious and human. Painterly realism, intricate medieval textures, believable atmospheric depth, premium album artwork, clear focal point, generous negative space near the edges for video motion. Completely original setting and character design. No modern objects, no readable text, no letters, no typography, no logo, no watermark, no border, no duplicate people, no celebrity likeness.`;
  return {hash:createHash('sha256').update(scene).digest('hex'),title:title.slice(0,100),prompt,seed:digest.readUInt32BE(6)&0x7fffffff,scene};
}

export function createCloudflareImageGenerator(): ImageGenerator | null {
  const account=(process.env.CLOUDFLARE_ACCOUNT_ID||process.env.R2_ACCOUNT_ID||'').trim();
  const token=(process.env.CLOUDFLARE_AI_TOKEN||'').trim();
  if(!/^[a-f0-9]{32}$/i.test(account)||token.length<20)return null;
  return async(prompt,seed,signal)=>{
    const controller=new AbortController();
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort(),90000);
    try{
      const form=new FormData();form.set('prompt',prompt);form.set('width','1280');form.set('height','720');form.set('guidance','3.5');form.set('seed',String(seed));
      const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form,signal:controller.signal});
      if(!response.ok)throw new Error('Генератор образів не відповів. Перевір Workers AI token і денний ліміт.');
      const length=Number(response.headers.get('content-length')||0);if(length>MAX_GENERATED_IMAGE_BYTES*1.5)throw new Error('Генератор повернув завеликий результат.');
      const payload=await response.json() as {success?:boolean;result?:{image?:string};errors?:unknown[]};
      const encoded=payload.result?.image;if(!payload.success||typeof encoded!=='string'||encoded.length>MAX_GENERATED_IMAGE_BYTES*1.5)throw new Error('Workers AI не повернув готову картинку.');
      const data=Buffer.from(encoded,'base64');if(data.length<16||data.length>MAX_GENERATED_IMAGE_BYTES)throw new Error('Згенерована картинка має неправильний розмір.');
      const kind=mediaKind(data.subarray(0,16),true);return {data,type:kind==='png'?'image/png':'image/jpeg'};
    }catch(error){if(error instanceof Error&&/Генератор|Workers AI|Згенерована/.test(error.message))throw error;throw new Error('Генерація образу перервалася. Спробуй повтор випуску.');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  };
}
