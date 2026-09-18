import { readFile } from 'node:fs/promises';
import { openAIConfig, OpenAIProviderError } from './openai-provider.js';
import { buildWhisperLyricsPrompt } from './video-lyrics.js';

export type ShortsLyricCue = { start:number; end:number; text:string; accent:string };
type TranscriptionWord = { word?:unknown; start?:unknown; end?:unknown };

const stopWords=new Set(['a','an','and','are','as','at','be','but','by','for','from','i','if','in','is','it','me','my','of','on','or','our','the','then','through','to','we','when','where','with','you','your']);
const cleanWord=(value:unknown)=>String(value??'').normalize('NFKC').replace(/[^\p{L}\p{N}'’\-]/gu,'').slice(0,28);
const cleanPhrase=(value:string)=>value.normalize('NFKC').replace(/[^\p{L}\p{N}\s'’\-,.!?]/gu,' ').replace(/\s+/g,' ').trim().slice(0,88);
const accentOf=(words:string[])=>words.filter(Boolean).sort((a,b)=>{
  const aScore=(stopWords.has(a.toLowerCase())?0:20)+a.length,bScore=(stopWords.has(b.toLowerCase())?0:20)+b.length;
  return bScore-aScore;
})[0]||words[0]||'';

export function buildShortsLyricCues(input:TranscriptionWord[],duration=30):ShortsLyricCue[]{
  const words=input.map(item=>({word:cleanWord(item.word),start:Number(item.start),end:Number(item.end)}))
    .filter(item=>item.word&&Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.start>=0&&item.start<duration&&item.end>item.start)
    .sort((a,b)=>a.start-b.start);
  const groups:Array<typeof words>=[];let group:typeof words=[];
  const flush=()=>{if(group.length)groups.push(group);group=[];};
  for(const word of words){
    const previous=group.at(-1),span=group.length?word.end-group[0]!.start:0;
    if(group.length&&(group.length>=5||span>2.7||(previous&&word.start-previous.end>.55)))flush();
    group.push(word);
  }
  flush();
  return groups.slice(0,12).map((items,index)=>{
    const tokens=items.map(item=>item.word),start=Math.max(0,items[0]!.start-.08),next=groups[index+1]?.[0]?.start;
    const end=Math.min(duration,Math.max(items.at(-1)!.end+.12,start+.7,next===undefined?0:next-.05));
    return {start:Number(start.toFixed(2)),end:Number(end.toFixed(2)),text:cleanPhrase(tokens.join(' ')),accent:accentOf(tokens).toUpperCase()};
  }).filter(cue=>cue.text&&cue.accent&&cue.end>cue.start);
}

export function buildStoryCaptionCues(hook:string,duration=30):ShortsLyricCue[]{
  const words=cleanPhrase(hook).split(/\s+/).filter(Boolean).slice(0,12),middle=Math.max(3,Math.ceil(words.length/2));
  return [words.slice(0,middle),words.slice(middle)].filter(part=>part.length).map((part,index)=>({
    start:index?3.4:.35,end:index?6.3:3.25,text:part.join(' '),accent:accentOf(part).toUpperCase()
  })).filter(cue=>cue.start<duration).map(cue=>({...cue,end:Math.min(duration,cue.end)}));
}

export const shortsTranscriptionConfigured=()=>openAIConfig().configured;

export async function transcribeShortsLyrics(file:string,knownLyrics='',signal?:AbortSignal):Promise<ShortsLyricCue[]|null>{
  const {key,configured}=openAIConfig();if(!configured)return null;
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(),90000);
  try{
    const audio=await readFile(file);if(audio.length<100||audio.length>4*1024*1024)return null;
    const form=new FormData();form.set('file',new Blob([audio],{type:'audio/mpeg'}),'shorts-clip.mp3');form.set('model','whisper-1');form.set('language','en');form.set('response_format','verbose_json');form.append('timestamp_granularities[]','word');form.set('temperature','0');
    const guide=buildWhisperLyricsPrompt(knownLyrics);if(guide)form.set('prompt',guide);
    const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`},body:form,signal:controller.signal});
    if(!response.ok){
      await response.body?.cancel();const retryable=[408,409,429,500,502,503,504].includes(response.status);
      const message=response.status===400?'OpenAI відхилив параметри синхронізації Shorts (HTTP 400).'
        :response.status===401||response.status===403?'OpenAI не прийняв локальний API-ключ або доступ до Whisper.'
        :response.status===429?'OpenAI повернув ліміт запитів або недостатній API-баланс (HTTP 429).'
        :`OpenAI не зміг розпізнати вокал для Shorts (HTTP ${response.status}).`;
      throw new OpenAIProviderError(message,response.status,retryable);
    }
    const payload=await response.json() as {words?:TranscriptionWord[]};const cues=buildShortsLyricCues(Array.isArray(payload.words)?payload.words:[]);
    return cues.length>=2?cues:null;
  }catch(error){
    if(error instanceof OpenAIProviderError)throw error;
    if(signal?.aborted)throw new OpenAIProviderError('Розпізнавання вокалу перервано.',503,false);
    throw new OpenAIProviderError('Розпізнавання вокалу тимчасово недоступне.',503,true);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
