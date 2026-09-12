import { createHash } from 'node:crypto';
import { mediaKind } from './media-render.js';

export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;
export const GENERATED_SCENE_COUNT = 3;
export type SceneConcept = { hash:string; prompt:string; seed:number; scene:string; label:string };
export type ReleaseConcept = { hash: string; title: string; prompt: string; seed: number; scene: string; scenes:SceneConcept[] };
export type ImageGenerator = (prompt: string, seed: number, signal?: AbortSignal) => Promise<{ data: Buffer; type: 'image/jpeg'|'image/png' }>;

const places = ['a timber longhouse above a winter fjord','a mountain pass overlooking the northern sea','a black-sand shore beside a beached longship','a firelit oath circle beneath ancient pines','a cliff village facing an approaching storm','a frozen harbor at blue dawn','a high valley marked by weathered standing stones','a longship crossing a narrow misty fjord'];
const subjects = ['two sworn brothers preparing to part','a weathered skald holding a carved lyre','a returning voyager facing the lights of home','an original shieldmaiden waiting beside the fire','a small crew raising their oars in silence','a lone mountain messenger carrying a broken banner','a father and grown son meeting after many winters','two original singers answering one another across the hall'];
const weather = ['slow rolling sea mist','fine rain crossing the frame','silent northern snowfall','wind carrying sparks from the oath fire','low storm clouds over the fjord','cold haze after rain','drifting woodsmoke from the longhouse','moonlit fog beneath the mountains'];
const light = ['muted moonlight and warm oath-fire','deep amber firelight against forest-green shadows','a cold blue dawn with muted gold reflections','distant lightning behind slate mountains','soft firelight reflected on wet timber','a narrow beam of pale sunlight through storm clouds'];
const compositions = ['wide cinematic establishing shot','low-angle heroic but human composition','layered landscape with strong foreground silhouettes','symmetrical longhouse composition with deep perspective','distant panoramic view with atmospheric depth','intimate medium-wide scene framed by timber posts'];

const pick = <T>(items: T[], byte: number):T => items[byte % items.length]!;
export function buildReleaseConcept(trackHash: string, attempt = 0): ReleaseConcept {
  const digest = createHash('sha256').update(trackHash+':'+attempt).digest();
  const byte=(index:number)=>digest[index]??0;
  const place=pick(places,byte(0)),subject=pick(subjects,byte(1)),climate=pick(weather,byte(2)),lighting=pick(light,byte(3)),composition=pick(compositions,byte(4));
  const placeTitle=place.replace(/^(a|an|the) /,'').split(' ').map(v=>v.charAt(0).toUpperCase()+v.slice(1)).join(' ');
  const titlePrefixes=['Oath of','When We Cross','Voices Above','The Road Beyond','Under the','Call of'];
  const title=pick(titlePrefixes,byte(5))+' '+placeTitle;
  const story=[
    {label:'Вступ',shot:'wide establishing view that reveals the place before the story begins',moment:`${subject} appears small and distant`},
    {label:'Розвиток',shot:composition,moment:`the same ${subject.replace(/^(a|an) /,'')} is now the clear focal point and the atmosphere grows heavier`},
    {label:'Кульмінація',shot:'dramatic cinematic culmination with strong foreground silhouettes and deep perspective',moment:`the same ${subject.replace(/^(a|an) /,'')} faces the heart of the mystery`}
  ];
  const scenes=story.map((part,index)=>{
    const scene=`${part.label}: ${place}; ${part.moment}; ${climate}; ${lighting}; ${part.shot}`;
    const prompt=`Create scene ${index+1} of 3 for one coherent original Veil of Ages Viking song visual story. Keep the same place, subject identity, historically inspired costume language, weather, forest-green, slate, charcoal and muted-gold palette across all three scenes. Story moment: ${scene}. Epic Nordic cinematic realism, but human and emotionally specific rather than a generic battle poster. Authentic timber, wool, leather, iron and weathered wood textures, believable atmospheric depth, premium 16:9 cinematic frame and one clear focal point. Completely original setting and character design. No fantasy armor exaggeration, no modern objects, no readable text, no letters, no typography, no logo, no watermark, no border, no duplicate people, no celebrity likeness.`;
    const hash=createHash('sha256').update(`${trackHash}:${attempt}:${index}:${scene}`).digest('hex');
    const sceneDigest=createHash('sha256').update(hash).digest();
    return {hash,prompt,seed:sceneDigest.readUInt32BE(0)&0x7fffffff,scene,label:part.label};
  });
  const hash=createHash('sha256').update(scenes.map(value=>value.hash).join(':')).digest('hex');
  return {hash,title:title.slice(0,100),prompt:scenes[0]!.prompt,seed:scenes[0]!.seed,scene:scenes[0]!.scene,scenes};
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
