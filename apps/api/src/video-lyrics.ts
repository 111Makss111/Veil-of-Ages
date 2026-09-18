import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { openAIConfig, OpenAIProviderError } from './openai-provider.js';
import { buildVideoLyricFrame } from './factory-thumbnail.js';

export type VideoLyricCue={
  start:number;
  end:number;
  text:string;
  accent:string;
  emphasis:'verse'|'chorus'|'bridge';
  position:'upper'|'center'|'lower';
};
export type VideoLyricTrack={manifestPath:string;cueCount:number};
type TranscriptionWord={word?:unknown;start?:unknown;end?:unknown};

const stopWords=new Set(['a','an','and','are','as','at','be','but','by','for','from','i','if','in','is','it','me','my','of','on','or','our','the','then','through','to','we','when','where','with','you','your']);
const cleanWord=(value:unknown)=>String(value??'').normalize('NFKC').replace(/[^\p{L}\p{N}'’-]/gu,'').slice(0,32);
const cleanPhrase=(value:string)=>value.normalize('NFKC').replace(/[^\p{L}\p{N}\s'’\-,.!?]/gu,' ').replace(/\s+/g,' ').trim().slice(0,110);
const normalize=(value:string)=>cleanPhrase(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const accentOf=(words:string[])=>words.filter(Boolean).sort((a,b)=>{
  const aScore=(stopWords.has(a.toLowerCase())?0:30)+Math.min(18,a.length),bScore=(stopWords.has(b.toLowerCase())?0:30)+Math.min(18,b.length);
  return bScore-aScore;
})[0]||words[0]||'';

// whisper-1 accepts only a short prompt (224 tokens). A compact set of
// distinctive lyric words improves names and Nordic vocabulary without
// sending the full song text or causing a rejected transcription request.
export function buildWhisperLyricsPrompt(lyrics:string){
  const seen=new Set<string>(),keywords:string[]=[];
  const words=lyrics.replace(/\[[^\]]+]/g,' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)||[];
  for(const value of words){
    const word=cleanWord(value),key=word.toLowerCase();
    if(!word||word.length<2||stopWords.has(key)||seen.has(key))continue;
    seen.add(key);keywords.push(word);
    if(keywords.length>=80)break;
  }
  return keywords.join(', ').slice(0,700);
}

function transcriptionError(status:number){
  const retryable=[408,409,429,500,502,503,504].includes(status);
  const message=status===400?'OpenAI відхилив параметри синхронізації (HTTP 400).'
    :status===401||status===403?'OpenAI не прийняв локальний API-ключ або доступ до Whisper.'
    :status===429?'OpenAI повернув ліміт запитів або недостатній API-баланс (HTTP 429).'
    :`OpenAI не зміг синхронізувати слова повної пісні (HTTP ${status}).`;
  return new OpenAIProviderError(message,status,retryable);
}

function sectionText(lyrics:string,label:string){
  const sections=[...lyrics.matchAll(/\[([^\]]+)]([\s\S]*?)(?=\[[^\]]+]|$)/g)];
  return normalize(sections.filter(match=>match[1]!.toLowerCase().includes(label)).map(match=>match[2]).join(' '));
}

export function buildVideoLyricCues(input:TranscriptionWord[],duration:number,knownLyrics=''):VideoLyricCue[]{
  const words=input.map(item=>({word:cleanWord(item.word),raw:String(item.word??''),start:Number(item.start),end:Number(item.end)}))
    .filter(item=>item.word&&Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.start>=0&&item.start<duration&&item.end>item.start)
    .sort((a,b)=>a.start-b.start);
  const groups:Array<typeof words>=[];let group:typeof words=[];
  const flush=()=>{if(group.length)groups.push(group);group=[];};
  for(const word of words){
    const previous=group.at(-1),span=group.length?word.end-group[0]!.start:0,punctuation=previous?/[,;:.!?]$/.test(previous.raw.trim()):false;
    if(group.length&&(group.length>=6||span>3.15||(previous&&word.start-previous.end>.62)||(punctuation&&group.length>=3)))flush();
    group.push(word);
  }
  flush();
  const chorus=sectionText(knownLyrics,'chorus'),bridge=sectionText(knownLyrics,'bridge');
  const phraseCounts=new Map<string,number>();
  for(const items of groups){const key=normalize(items.map(item=>item.word).join(' '));if(key)phraseCounts.set(key,(phraseCounts.get(key)||0)+1);}
  return groups.slice(0,150).map((items,index)=>{
    const tokens=items.map(item=>item.word),phrase=cleanPhrase(tokens.join(' ')),key=normalize(phrase),start=Math.max(0,items[0]!.start-.08),next=groups[index+1]?.[0]?.start;
    const end=Math.min(duration,Math.max(items.at(-1)!.end+.15,start+.65,next===undefined?0:next-.04));
    const inChorus=key.length>5&&chorus.includes(key),inBridge=key.length>5&&bridge.includes(key),repeated=(phraseCounts.get(key)||0)>1;
    const emphasis:VideoLyricCue['emphasis']=inChorus||repeated?'chorus':inBridge?'bridge':'verse';
    const position:VideoLyricCue['position']=emphasis==='chorus'?'center':index%4===1?'upper':index%4===3?'lower':'center';
    return {start:Number(start.toFixed(2)),end:Number(end.toFixed(2)),text:phrase,accent:accentOf(tokens).toUpperCase(),emphasis,position};
  }).filter(cue=>cue.text&&cue.accent&&cue.end>cue.start);
}

export const videoTranscriptionConfigured=()=>openAIConfig().configured;

export async function transcribeVideoLyrics(file:string,knownLyrics:string,duration:number,signal?:AbortSignal):Promise<VideoLyricCue[]|null>{
  const {key,configured}=openAIConfig();if(!configured)return null;
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(),4*60*1000);
  try{
    const audio=await readFile(file);if(audio.length<100||audio.length>24*1024*1024)return null;
    const form=new FormData();form.set('file',new Blob([audio],{type:'audio/mpeg'}),'full-song.mp3');form.set('model','whisper-1');form.set('language','en');form.set('response_format','verbose_json');form.append('timestamp_granularities[]','word');form.set('temperature','0');
    const guide=buildWhisperLyricsPrompt(knownLyrics);if(guide)form.set('prompt',guide);
    const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`},body:form,signal:controller.signal});
    if(!response.ok){await response.body?.cancel();throw transcriptionError(response.status);}
    const payload=await response.json() as {words?:TranscriptionWord[]};const cues=buildVideoLyricCues(Array.isArray(payload.words)?payload.words:[],duration,knownLyrics);
    return cues.length>=4?cues:null;
  }catch(error){
    if(error instanceof OpenAIProviderError)throw error;
    if(signal?.aborted)throw new OpenAIProviderError('Синхронізацію слів перервано.',503,false);
    throw new OpenAIProviderError('Синхронізація слів тимчасово недоступна.',503,true);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

const manifestFile=(name:string,duration:number)=>`file '${name.replace(/'/g,"'\\''")}'\nduration ${Math.max(.04,duration).toFixed(3)}\n`;

export async function buildVideoLyricTrack(directory:string,cues:ReadonlyArray<VideoLyricCue>,duration:number,onProgress?:(done:number,total:number)=>void):Promise<VideoLyricTrack|null>{
  const valid=cues.filter(cue=>Number.isFinite(cue.start)&&Number.isFinite(cue.end)&&cue.start>=0&&cue.end>cue.start&&cue.start<duration).slice(0,150);
  if(!valid.length)return null;
  const emptyName='lyrics-empty.png',emptyPath=join(directory,emptyName);
  await sharp({create:{width:1280,height:720,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png({compressionLevel:9,palette:true}).toFile(emptyPath);
  let manifest='ffconcat version 1.0\n',cursor=0,lastName=emptyName;
  for(const [index,cue] of valid.entries()){
    const start=Math.max(cursor,Math.min(duration,cue.start)),end=Math.max(start+.04,Math.min(duration,cue.end));
    if(start-cursor>.035)manifest+=manifestFile(emptyName,start-cursor);
    const intro=Math.min(.14,Math.max(.07,(end-start)*.16)),introName=`lyrics-${String(index).padStart(3,'0')}-in.png`,holdName=`lyrics-${String(index).padStart(3,'0')}.png`;
    await writeFile(join(directory,introName),await buildVideoLyricFrame(cue,index,'enter'));
    await writeFile(join(directory,holdName),await buildVideoLyricFrame(cue,index,'hold'));
    manifest+=manifestFile(introName,intro);
    if(end-start-intro>.035)manifest+=manifestFile(holdName,end-start-intro);
    cursor=end;lastName=holdName;onProgress?.(index+1,valid.length);
  }
  if(duration-cursor>.035){manifest+=manifestFile(emptyName,duration-cursor);lastName=emptyName;}
  manifest+=`file '${basename(lastName)}'\n`;
  const manifestPath=join(directory,'lyrics.ffconcat');await writeFile(manifestPath,manifest,'utf8');
  return {manifestPath,cueCount:valid.length};
}
