import { readFile } from 'node:fs/promises';
import { openAIConfig, OpenAIProviderError } from './openai-provider.js';
import { buildWhisperLyricsPrompt } from './video-lyrics.js';

export type ShortsLyricCue = { start:number; end:number; text:string; accent:string };
export type ShortsLyricSelection = { clipStart:number; clipDuration:number; section:'chorus'|'vocal'; cues:ShortsLyricCue[] };
type TranscriptionWord = { word?:unknown; start?:unknown; end?:unknown };
type TimedWord = { word:string; key:string; start:number; end:number };
type LyricToken = { word:string; key:string; line:number; chorus:boolean };

const stopWords=new Set(['a','an','and','are','as','at','be','but','by','for','from','i','if','in','is','it','me','my','of','on','or','our','the','then','through','to','we','when','where','with','you','your']);
const cleanWord=(value:unknown)=>String(value??'').normalize('NFKC').replace(/[^\p{L}\p{N}'’\-]/gu,'').slice(0,32);
const wordKey=(value:unknown)=>cleanWord(value).toLowerCase().replace(/[’']/g,'').replace(/-+/g,'');
const cleanPhrase=(value:string)=>value.normalize('NFKC').replace(/[^\p{L}\p{N}\s'’\-,.!?]/gu,' ').replace(/\s+/g,' ').trim().slice(0,110);
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

function lyricTokens(lyrics:string){
  const tokens:LyricToken[]=[],lines=new Map<number,number[]>();let section='',line=0;
  for(const raw of lyrics.replace(/\r/g,'').split('\n')){
    const label=/^\s*\[([^\]]+)]\s*$/.exec(raw);
    if(label){section=label[1]!.toLowerCase();continue;}
    const words=raw.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)||[];
    if(!words.length)continue;
    const indexes:number[]=[];
    for(const value of words){const word=cleanWord(value),key=wordKey(word);if(!key)continue;indexes.push(tokens.length);tokens.push({word,key,line,chorus:section.includes('chorus')});}
    if(indexes.length){lines.set(line,indexes);line++;}
  }
  return {tokens,lines};
}

function alignLyrics(lyrics:LyricToken[],speech:TimedWord[]){
  const n=lyrics.length,m=speech.length,rows=Array.from({length:n+1},()=>new Uint16Array(m+1));
  for(let i=1;i<=n;i++)for(let j=1;j<=m;j++)rows[i]![j]=lyrics[i-1]!.key===speech[j-1]!.key?rows[i-1]![j-1]!+1:Math.max(rows[i-1]![j]!,rows[i]![j-1]!);
  const matches=new Map<number,number>();let i=n,j=m;
  while(i>0&&j>0){if(lyrics[i-1]!.key===speech[j-1]!.key){matches.set(i-1,j-1);i--;j--;}else{const up=rows[i-1]![j]??0,left=rows[i]![j-1]??0;if(up>=left)i--;else j--;}}
  return matches;
}

function splitLine(indexes:number[],size=6){const count=Math.ceil(indexes.length/size),balanced=Math.ceil(indexes.length/count),chunks:number[][]=[];for(let i=0;i<indexes.length;i+=balanced)chunks.push(indexes.slice(i,i+balanced));return chunks;}

export function selectShortsLyrics(input:TranscriptionWord[],knownLyrics:string,duration:number):ShortsLyricSelection|null{
  const speech:TimedWord[]=input.map(item=>({word:cleanWord(item.word),key:wordKey(item.word),start:Number(item.start),end:Number(item.end)}))
    .filter(item=>item.key&&Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.start>=0&&item.end>item.start&&item.start<duration)
    .sort((a,b)=>a.start-b.start);
  const parsed=lyricTokens(knownLyrics),matches=alignLyrics(parsed.tokens,speech);
  if(!parsed.tokens.length||speech.length<4||matches.size<Math.max(6,Math.floor(parsed.tokens.length*.12)))return null;
  const absolute:Array<ShortsLyricCue&{chorus:boolean}>=[];
  for(const indexes of parsed.lines.values())for(const chunk of splitLine(indexes)){
    const matched=chunk.map(index=>matches.get(index)).filter((value):value is number=>value!==undefined).sort((a,b)=>a-b);
    if(matched.length<Math.max(2,Math.ceil(chunk.length*.45)))continue;
    const words=chunk.map(index=>parsed.tokens[index]!.word),first=speech[matched[0]!]!,last=speech[matched.at(-1)!]!;
    const start=Math.max(0,first.start-.1),end=Math.min(duration,Math.max(last.end+.16,start+.65));
    absolute.push({start,end,text:cleanPhrase(words.join(' ')),accent:accentOf(words).toUpperCase(),chorus:chunk.some(index=>parsed.tokens[index]!.chorus)});
  }
  if(absolute.length<2)return null;
  const clipDuration=Math.min(30,duration),limit=Math.max(0,duration-clipDuration),chorus=absolute.filter(cue=>cue.chorus),anchors=(chorus.length?chorus:absolute).flatMap(cue=>[cue.start-1,cue.end-clipDuration+1]).concat([0,limit]);
  let clipStart=0,best=-Infinity;
  for(const raw of anchors){const start=Math.max(0,Math.min(limit,raw)),end=start+clipDuration;let score=0;
    for(const cue of absolute){const overlap=Math.max(0,Math.min(end,cue.end)-Math.max(start,cue.start));if(overlap>0)score+=overlap*(cue.chorus?5:1)+cue.text.split(/\s+/).length*(cue.chorus?1.2:.2);}
    if(score>best){best=score;clipStart=start;}
  }
  const cues=absolute.filter(cue=>cue.end>clipStart&&cue.start<clipStart+clipDuration).slice(0,18).map(cue=>({
    start:Number(Math.max(0,cue.start-clipStart).toFixed(2)),end:Number(Math.min(clipDuration,cue.end-clipStart).toFixed(2)),text:cue.text,accent:cue.accent
  })).filter(cue=>cue.end>cue.start);
  if(cues.length<2)return null;
  return {clipStart:Number(clipStart.toFixed(2)),clipDuration:Number(clipDuration.toFixed(2)),section:chorus.length?'chorus':'vocal',cues};
}

export const shortsTranscriptionConfigured=()=>openAIConfig().configured;

export async function transcribeShortsLyrics(file:string,knownLyrics:string,duration:number,signal?:AbortSignal):Promise<ShortsLyricSelection|null>{
  const {key,configured}=openAIConfig();if(!configured)return null;
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(),4*60*1000);
  try{
    const audio=await readFile(file);if(audio.length<100||audio.length>24*1024*1024)return null;
    const form=new FormData();form.set('file',new Blob([audio],{type:'audio/mpeg'}),'full-song.mp3');form.set('model','whisper-1');form.set('language','en');form.set('response_format','verbose_json');form.append('timestamp_granularities[]','word');form.set('temperature','0');
    const guide=buildWhisperLyricsPrompt(knownLyrics);if(guide)form.set('prompt',guide);
    const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`},body:form,signal:controller.signal});
    if(!response.ok){
      await response.body?.cancel();const retryable=[408,409,429,500,502,503,504].includes(response.status);
      const message=response.status===400?'OpenAI відхилив параметри синхронізації Shorts (HTTP 400).'
        :response.status===401||response.status===403?'OpenAI не прийняв API-ключ або доступ до Whisper.'
        :response.status===429?'OpenAI повернув ліміт запитів або недостатній API-баланс (HTTP 429).'
        :`OpenAI не зміг синхронізувати вокал для Shorts (HTTP ${response.status}).`;
      throw new OpenAIProviderError(message,response.status,retryable);
    }
    const payload=await response.json() as {words?:TranscriptionWord[]};
    return selectShortsLyrics(Array.isArray(payload.words)?payload.words:[],knownLyrics,duration);
  }catch(error){
    if(error instanceof OpenAIProviderError)throw error;
    if(signal?.aborted)throw new OpenAIProviderError('Синхронізацію вокалу перервано.',503,false);
    throw new OpenAIProviderError('Синхронізація вокалу тимчасово недоступна.',503,true);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
