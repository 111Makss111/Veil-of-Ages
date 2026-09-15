import { createHash } from 'node:crypto';
import { mediaKind } from './media-render.js';
import { openAIConfig, openAIRequest, OpenAIProviderError } from './openai-provider.js';

export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;
export const GENERATED_SCENE_COUNT = 3;
export type SceneConcept = { hash:string; prompt:string; seed:number; scene:string; label:string };
export type ReleaseConcept = { hash: string; title: string; prompt: string; seed: number; scene: string; scenes:SceneConcept[] };
export type SongVisualBrief = { title:string; concept:string; artworkPrompt:string };
export type ImageFormat = 'landscape'|'portrait';
export type ImageGenerator = (prompt: string, seed: number, signal?: AbortSignal, options?:{format?:ImageFormat}) => Promise<{ data: Buffer; type: 'image/jpeg'|'image/png' }>;

const places = ['a timber longhouse above a winter fjord','a mountain pass overlooking the northern sea','a black-sand shore beside a beached longship','a firelit oath circle beneath ancient pines','a cliff village facing an approaching storm','a frozen harbor at blue dawn','a high valley marked by weathered standing stones','a longship crossing a narrow misty fjord'];
const subjects = ['two sworn brothers preparing to part','a weathered skald holding a carved lyre','a returning voyager facing the lights of home','an original shieldmaiden waiting beside the fire','a small crew raising their oars in silence','a lone mountain messenger carrying a broken banner','a father and grown son meeting after many winters','two original singers answering one another across the hall'];
const weather = ['slow rolling sea mist','fine rain crossing the frame','silent northern snowfall','wind carrying sparks from the oath fire','low storm clouds over the fjord','cold haze after rain','drifting woodsmoke from the longhouse','moonlit fog beneath the mountains'];
const light = ['muted moonlight and warm oath-fire','deep amber firelight against forest-green shadows','a cold blue dawn with muted gold reflections','distant lightning behind slate mountains','soft firelight reflected on wet timber','a narrow beam of pale sunlight through storm clouds'];
const compositions = ['wide cinematic establishing shot','low-angle heroic but human composition','layered landscape with strong foreground silhouettes','symmetrical longhouse composition with deep perspective','distant panoramic view with atmospheric depth','intimate medium-wide scene framed by timber posts'];

const pick = <T>(items: T[], byte: number):T => items[byte % items.length]!;
export function buildReleaseConcept(trackHash: string, attempt = 0, creative?:SongVisualBrief): ReleaseConcept {
  const digest = createHash('sha256').update(trackHash+':'+attempt).digest();
  const byte=(index:number)=>digest[index]??0;
  const place=pick(places,byte(0)),subject=pick(subjects,byte(1)),climate=pick(weather,byte(2)),lighting=pick(light,byte(3)),composition=pick(compositions,byte(4));
  const placeTitle=place.replace(/^(a|an|the) /,'').split(' ').map(v=>v.charAt(0).toUpperCase()+v.slice(1)).join(' ');
  const titlePrefixes=['Oath of','When We Cross','Voices Above','The Road Beyond','Under the','Call of'];
  const title=creative?.title||(pick(titlePrefixes,byte(5))+' '+placeTitle);
  const story=creative?[
    {label:'Вступ',shot:'wide cinematic establishing shot',moment:'a visual prologue that introduces both original adult Viking characters and their emotional question'},
    {label:'Розвиток',shot:'intimate medium-wide composition with strong atmospheric depth',moment:'the emotional center of the story with the same recognizable man, woman, costumes and location'},
    {label:'Кульмінація',shot:'powerful cinematic concluding composition with one clear focal point',moment:'the visual resolution while preserving the same characters, costume language, place and palette'}
  ]:[
    {label:'Вступ',shot:'wide establishing view that reveals the place before the story begins',moment:`${subject} appears small and distant`},
    {label:'Розвиток',shot:composition,moment:`the same ${subject.replace(/^(a|an) /,'')} is now the clear focal point and the atmosphere grows heavier`},
    {label:'Кульмінація',shot:'dramatic cinematic culmination with strong foreground silhouettes and deep perspective',moment:`the same ${subject.replace(/^(a|an) /,'')} faces the heart of the mystery`}
  ];
  const scenes=story.map((part,index)=>{
    const scene=creative?`${part.label}: ${part.moment}; ${part.shot}`:`${part.label}: ${place}; ${part.moment}; ${climate}; ${lighting}; ${part.shot}`;
    const direction=creative?` Song story: ${creative.concept.slice(0,600)}. Approved artwork direction: ${creative.artworkPrompt.slice(0,1200)}.`:'';
    const prompt=`Create scene ${index+1} of 3 for one coherent original Veil of Ages Viking song visual story.${direction} Keep the same place, subject identity, historically inspired costume language, weather, forest-green, slate, charcoal and muted-gold palette across all three scenes. Story moment: ${scene}. Epic Nordic cinematic realism, attractive expressive adult characters, human and emotionally specific rather than a generic battle poster. Authentic timber, wool, leather, iron and weathered wood textures, believable atmospheric depth, premium 16:9 cinematic frame and one clear focal point. Completely original setting and character design. No fantasy armor exaggeration, no modern objects, no readable text, no letters, no typography, no logo, no watermark, no border, no duplicate people, no celebrity likeness.`;
    const hash=createHash('sha256').update(`${trackHash}:${attempt}:${index}:${scene}:${creative?.artworkPrompt||''}`).digest('hex');
    const sceneDigest=createHash('sha256').update(hash).digest();
    return {hash,prompt,seed:sceneDigest.readUInt32BE(0)&0x7fffffff,scene,label:part.label};
  });
  const hash=createHash('sha256').update(scenes.map(value=>value.hash).join(':')).digest('hex');
  return {hash,title:title.slice(0,100),prompt:scenes[0]!.prompt,seed:scenes[0]!.seed,scene:scenes[0]!.scene,scenes};
}

export function buildShortsConcept(releaseKey:string,title:string,recipe:Record<string,unknown>={}){
  const digest=createHash('sha256').update(`shorts:${releaseKey}:${title}`).digest();
  const story=String(recipe.youtubeDescription||recipe.scene||'An original Viking song story in the Veil of Ages world.').replace(/#[\w-]+/g,' ').replace(/\s+/g,' ').trim().slice(0,900);
  const prompt=`Create a brand-new dedicated vertical 9:16 key visual for a 30-second YouTube Shorts presentation of the original Veil of Ages song “${title}”. Story and mood: ${story}. Epic Nordic cinematic realism, historically inspired wool, leather, iron and weathered timber, forest-green, slate, charcoal and muted-gold palette, dramatic natural atmosphere, premium photographic depth. IMPORTANT PORTRAIT COMPOSITION: place the main adult Viking character or pair fully inside the central 55% of the frame; show complete faces, heads, shoulders and hands; never crop a person at the left or right edge; keep all important subjects inside a safe central area with generous scenery on both sides; preserve calm negative space at the top for the brand and across the lower third for the song title. One clear focal point, strong vertical depth from foreground to distant landscape. Completely original people and setting. No readable text, letters, logo, watermark, border, duplicate people, celebrity likeness or modern objects.`;
  return {hash:createHash('sha256').update(prompt+releaseKey).digest('hex'),prompt,seed:digest.readUInt32BE(0)&0x7fffffff};
}

export function createCloudflareImageGenerator(): ImageGenerator | null {
  const account=(process.env.CLOUDFLARE_ACCOUNT_ID||process.env.R2_ACCOUNT_ID||'').trim();
  const token=(process.env.CLOUDFLARE_AI_TOKEN||'').trim();
  if(!/^[a-f0-9]{32}$/i.test(account)||token.length<20)return null;
  return async(prompt,seed,signal,options)=>{
    let lastStatus=0;
    for(let attempt=1;attempt<=3;attempt++){
      const controller=new AbortController();
      const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const timer=setTimeout(()=>controller.abort(),90000);
      try{
        const portrait=options?.format==='portrait';
        const form=new FormData();form.set('prompt',prompt);form.set('width',portrait?'720':'1280');form.set('height',portrait?'1280':'720');form.set('guidance','3.5');form.set('seed',String(seed));
        const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form,signal:controller.signal});
        lastStatus=response.status;
        if(!response.ok){await response.body?.cancel();if(![429,500,502,503,504].includes(response.status))throw new Error(response.status===401||response.status===403?'Workers AI не прийняв токен або право AI Run.':`Workers AI відхилив запит (код ${response.status}).`);}
        else{
          const length=Number(response.headers.get('content-length')||0);if(length>MAX_GENERATED_IMAGE_BYTES*1.5)throw new Error('Генератор повернув завеликий результат.');
          const payload=await response.json() as {success?:boolean;result?:{image?:string};errors?:unknown[]};
          const encoded=payload.result?.image;if(!payload.success||typeof encoded!=='string'||encoded.length>MAX_GENERATED_IMAGE_BYTES*1.5)throw new Error('Workers AI не повернув готову картинку.');
          const data=Buffer.from(encoded,'base64');if(data.length<16||data.length>MAX_GENERATED_IMAGE_BYTES)throw new Error('Згенерована картинка має неправильний розмір.');
          const kind=mediaKind(data.subarray(0,16),true);return {data,type:kind==='png'?'image/png':'image/jpeg'};
        }
      }catch(error){
        if(signal?.aborted)throw new Error('Генерацію образу перервано зупинкою сервера.');
        if(error instanceof Error&&/токен|право AI Run|відхилив|завеликий|не повернув|неправильний/.test(error.message))throw error;
        if(attempt===3)throw new Error(lastStatus===429?'Workers AI досяг ліміту запитів. Повтори пізніше.':'Workers AI тричі не відповів на створення образу.');
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
      await new Promise(resolve=>setTimeout(resolve,attempt*1200));
    }
    throw new Error('Workers AI не завершив створення образу.');
  };
}

export function createOpenAIImageGenerator():ImageGenerator|null{
  const {configured,imageModel}=openAIConfig();if(!configured)return null;
  return async(prompt,seed,signal,options)=>{
    let lastError:unknown;
    for(let attempt=1;attempt<=3;attempt++){
      try{
        const payload=await openAIRequest('images/generations',{model:imageModel,prompt:`${prompt}\nComposition variation reference: ${seed}.`,size:options?.format==='portrait'?'1024x1536':'1536x1024',quality:'medium',output_format:'jpeg'},signal,180000) as {data?:Array<{b64_json?:unknown}>};
        const encoded=payload.data?.[0]?.b64_json;
        if(typeof encoded!=='string'||encoded.length>MAX_GENERATED_IMAGE_BYTES*1.5)throw new OpenAIProviderError('OpenAI не повернув готову картинку.',503,false);
        const data=Buffer.from(encoded,'base64');if(data.length<16||data.length>MAX_GENERATED_IMAGE_BYTES)throw new OpenAIProviderError('Згенерована картинка має неправильний розмір.',503,false);
        const kind=mediaKind(data.subarray(0,16),true);return {data,type:kind==='png'?'image/png':'image/jpeg'};
      }catch(error){
        lastError=error;if(signal?.aborted)throw error;
        if(!(error instanceof OpenAIProviderError)||!error.retryable||attempt===3)throw error;
        await new Promise(resolve=>setTimeout(resolve,attempt*1200));
      }
    }
    throw lastError;
  };
}

export const imageGeneratorProvider=()=>openAIConfig().configured?'OpenAI':createCloudflareImageGenerator()?'Workers AI':null;

export function createPreferredImageGenerator():ImageGenerator|null{
  const openai=createOpenAIImageGenerator(),cloudflare=createCloudflareImageGenerator();
  if(!openai)return cloudflare;if(!cloudflare)return openai;
  return async(prompt,seed,signal,options)=>{
    try{return await openai(prompt,seed,signal,options);}
    catch(error){if(!(error instanceof OpenAIProviderError)||!error.retryable)throw error;return cloudflare(prompt,seed,signal,options);}
  };
}
