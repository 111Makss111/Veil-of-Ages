import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ShortsLyricCue } from './shorts-lyrics.js';

// Render has a small shared memory budget. Thumbnails are one-shot work, so a
// persistent libvips cache only competes with FFmpeg and YouTube uploads.
sharp.cache({memory:0,files:0,items:0});
sharp.concurrency(1);

const escapeXml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
function lines(title:string){
  const words=title.trim().split(/\s+/),result:string[]=[];let line='';
  for(const word of words){const next=line?line+' '+word:word;if(next.length>24&&line){result.push(line);line=word;}else line=next;if(result.length===2)break;}
  if(line&&result.length<3)result.push(line);return result.slice(0,3);
}
export async function buildYoutubeThumbnail(image:Buffer,title:string){
  const titleLines=lines(title),spans=titleLines.map((line,index)=>`<tspan x="70" dy="${index?74:0}">${escapeXml(line)}</tspan>`).join('');
  const overlay=Buffer.from(`<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#07120d" stop-opacity=".96"/><stop offset=".58" stop-color="#07120d" stop-opacity=".48"/><stop offset="1" stop-color="#07120d" stop-opacity="0"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><text x="70" y="72" fill="#c6ed9f" font-family="Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="7">VEIL OF AGES</text><text x="70" y="410" fill="#f4f5ed" stroke="#07120d" stroke-width="3" paint-order="stroke" font-family="Arial, sans-serif" font-size="66" font-weight="800">${spans}</text><rect x="70" y="635" width="160" height="6" rx="3" fill="#c6ed9f"/></svg>`);
  return sharp(image).resize(1280,720,{fit:'cover',position:'attention'}).composite([{input:overlay}]).jpeg({quality:90,mozjpeg:true}).toBuffer();
}

export async function buildShortsArtwork(image:Buffer,title:string){
  const titleLines=lines(title),spans=titleLines.map((line,index)=>`<tspan x="360" dy="${index?70:0}">${escapeXml(line)}</tspan>`).join('');
  const overlay=Buffer.from(`<svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06100b" stop-opacity=".92"/><stop offset="1" stop-color="#06100b" stop-opacity="0"/></linearGradient><linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06100b" stop-opacity="0"/><stop offset="1" stop-color="#06100b" stop-opacity=".96"/></linearGradient></defs><rect width="720" height="320" fill="url(#top)"/><rect y="700" width="720" height="580" fill="url(#bottom)"/><text x="360" y="76" text-anchor="middle" fill="#c6ed9f" font-family="Arial, sans-serif" font-size="22" font-weight="700" letter-spacing="6">VEIL OF AGES</text><text x="360" y="870" text-anchor="middle" fill="#fff" stroke="#07120d" stroke-width="4" paint-order="stroke" font-family="Arial, sans-serif" font-size="58" font-weight="800">${spans}</text><rect x="280" y="1090" width="160" height="5" rx="3" fill="#c6ed9f"/><text x="360" y="1150" text-anchor="middle" fill="#e7f0df" font-family="Arial, sans-serif" font-size="25" font-weight="700">FULL SONG ON VEIL OF AGES</text><text x="360" y="1194" text-anchor="middle" fill="#b6c9a8" font-family="Arial, sans-serif" font-size="20">Epic Viking Music</text></svg>`);
  return sharp(image).resize(720,1280,{fit:'cover',position:'attention'}).composite([{input:overlay}]).jpeg({quality:90,mozjpeg:true}).toBuffer();
}

export async function buildShortsStoryArtwork(image:Buffer,title:string,position:number,hook:string,kineticText=false){
  if(position===1&&!kineticText)return sharp(image).resize(720,1280,{fit:'cover',position:'attention'}).jpeg({quality:90,mozjpeg:true}).toBuffer();
  const final=position>=2,text=final?lines(title):lines(hook),font=final?58:46,y=final?870:850;
  const spans=text.map((line,index)=>`<tspan x="360" dy="${index?(final?70:58):0}">${escapeXml(line)}</tspan>`).join('');
  const footer=final?`<rect x="280" y="1090" width="160" height="5" rx="3" fill="#c6ed9f"/><text x="360" y="1150" text-anchor="middle" fill="#e7f0df" font-family="Arial, sans-serif" font-size="25" font-weight="700">FULL SONG ON VEIL OF AGES</text>`:'';
  const copy=kineticText?'':`<text x="360" y="${y}" text-anchor="middle" fill="#fff" stroke="#07120d" stroke-width="4" paint-order="stroke" font-family="Arial, sans-serif" font-size="${font}" font-weight="800">${spans}</text>`;
  const overlay=Buffer.from(`<svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06100b" stop-opacity=".82"/><stop offset="1" stop-color="#06100b" stop-opacity="0"/></linearGradient><linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06100b" stop-opacity="0"/><stop offset="1" stop-color="#06100b" stop-opacity=".94"/></linearGradient></defs><rect width="720" height="260" fill="url(#top)"/>${final?'<rect y="910" width="720" height="370" fill="url(#bottom)"/>':''}<text x="360" y="76" text-anchor="middle" fill="#c6ed9f" font-family="Arial, sans-serif" font-size="22" font-weight="700" letter-spacing="6">VEIL OF AGES</text>${copy}${footer}</svg>`);
  return sharp(image).resize(720,1280,{fit:'cover',position:'attention'}).composite([{input:overlay}]).jpeg({quality:90,mozjpeg:true}).toBuffer();
}

export async function buildKineticLyricOverlay(text:string,accent:string,index=0){
  const word=escapeXml((text||accent).trim().split(/\s+/)[0]!.slice(0,28).toUpperCase()),color=index%4===1?'#f0cf78':index%4===3?'#ffffff':'#c9f39f';
  const overlay=Buffer.from(`<svg width="680" height="220" xmlns="http://www.w3.org/2000/svg"><text x="340" y="137" text-anchor="middle" fill="#020805" fill-opacity=".58" font-family="Arial, sans-serif" font-size="98" font-weight="900" letter-spacing="4" transform="translate(0 8)">${word}</text><text x="340" y="137" text-anchor="middle" fill="${color}" stroke="#020805" stroke-width="9" paint-order="stroke" stroke-linejoin="round" font-family="Arial, sans-serif" font-size="98" font-weight="900" letter-spacing="4">${word}</text><path d="M238 166 H442" stroke="${color}" stroke-width="5" stroke-linecap="round" opacity=".78"/></svg>`);
  return sharp(overlay).png({compressionLevel:9,palette:true}).toBuffer();
}

const shortsManifestFile=(name:string,duration:number)=>`file '${name.replace(/'/g,"'\\''")}'\nduration ${Math.max(.04,duration).toFixed(3)}\n`;
export async function buildShortsLyricTrack(directory:string,cues:ReadonlyArray<ShortsLyricCue>,duration:number,onProgress?:(done:number,total:number)=>void){
  const valid=cues.filter(cue=>Number.isFinite(cue.start)&&Number.isFinite(cue.end)&&cue.start>=0&&cue.end>cue.start&&cue.start<duration).slice(0,72);
  if(!valid.length)return null;
  const emptyName='shorts-lyrics-empty.png',emptyPath=join(directory,emptyName);
  await sharp({create:{width:680,height:220,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png({compressionLevel:9,palette:true}).toFile(emptyPath);
  let manifest='ffconcat version 1.0\n',cursor=0,lastName=emptyName;
  for(const [index,cue] of valid.entries()){
    const start=Math.max(cursor,Math.min(duration,cue.start)),end=Math.max(start+.04,Math.min(duration,cue.end));
    if(start-cursor>.035)manifest+=shortsManifestFile(emptyName,start-cursor);
    const wordName=`short-word-${String(index).padStart(3,'0')}.png`;await writeFile(join(directory,wordName),await buildKineticLyricOverlay(cue.text,cue.accent,index));manifest+=shortsManifestFile(wordName,end-start);
    cursor=end;lastName=wordName;onProgress?.(index+1,valid.length);
  }
  if(duration-cursor>.035){manifest+=shortsManifestFile(emptyName,duration-cursor);lastName=emptyName;}
  manifest+=`file '${basename(lastName)}'\n`;
  const manifestPath=join(directory,'shorts-lyrics.ffconcat');await writeFile(manifestPath,manifest,'utf8');return {manifestPath,cueCount:valid.length};
}

function lyricLines(value:string){
  const words=value.trim().split(/\s+/).filter(Boolean),result:string[]=[];let line='';
  for(const word of words){const next=line?line+' '+word:word;if(next.length>38&&line){result.push(line);line=word;}else line=next;}
  if(line)result.push(line);return result.slice(0,2);
}

export async function buildVideoLyricFrame(cue:{text:string;accent:string;emphasis:'verse'|'chorus'|'bridge';position:'upper'|'center'|'lower'},index=0,phase:'enter'|'hold'='hold'){
  const strong=cue.emphasis==='chorus',bridge=cue.emphasis==='bridge',opacity=phase==='enter'?.46:1,offset=phase==='enter'?18:0;
  const yBase=cue.position==='upper'?230:cue.position==='lower'?505:365;
  const accentSize=strong?86:bridge?74:66,phraseSize=strong?54:bridge?49:45,color=strong?'#e6c776':index%3===1?'#d8b96b':'#c6ed9f';
  const phrase=lyricLines(cue.text),lineGap=phraseSize+8,startY=yBase+accentSize*.72+28+offset;
  const spans=phrase.map((line,lineIndex)=>`<tspan x="640" dy="${lineIndex?lineGap:0}">${escapeXml(line)}</tspan>`).join('');
  const accent=escapeXml(cue.accent.slice(0,32));
  const underline=strong?`<rect x="500" y="${yBase+18+offset}" width="280" height="4" rx="2" fill="#e6c776" fill-opacity=".8"/>`:'';
  const overlay=Buffer.from(`<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><g opacity="${opacity}"><text x="640" y="${yBase+offset}" text-anchor="middle" fill="${color}" stroke="#020805" stroke-width="7" paint-order="stroke" font-family="Arial, sans-serif" font-size="${accentSize-(phase==='enter'?5:0)}" font-weight="900" letter-spacing="${strong?4:2}">${accent}</text>${underline}<text x="640" y="${startY}" text-anchor="middle" fill="#f7f8f3" stroke="#020805" stroke-width="6" paint-order="stroke" font-family="Arial, sans-serif" font-size="${phraseSize-(phase==='enter'?3:0)}" font-weight="800">${spans}</text></g></svg>`);
  return sharp(overlay).png({compressionLevel:9,palette:true}).toBuffer();
}
