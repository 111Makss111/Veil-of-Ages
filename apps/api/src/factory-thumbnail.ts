import sharp from 'sharp';

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
  const phrase=lines(text).slice(0,2),spans=phrase.map((line,lineIndex)=>`<tspan x="340" dy="${lineIndex?47:0}">${escapeXml(line)}</tspan>`).join('');
  const color=index%3===1?'#e0c47d':'#c6ed9f',safeAccent=escapeXml(accent.slice(0,28));
  const overlay=Buffer.from(`<svg width="680" height="300" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="18" width="644" height="264" rx="28" fill="#06100b" fill-opacity=".72" stroke="#d8efc2" stroke-opacity=".2"/><text x="340" y="112" text-anchor="middle" fill="${color}" stroke="#06100b" stroke-width="3" paint-order="stroke" font-family="Arial, sans-serif" font-size="68" font-weight="900" letter-spacing="2">${safeAccent}</text><text x="340" y="187" text-anchor="middle" fill="#fff" stroke="#06100b" stroke-width="3" paint-order="stroke" font-family="Arial, sans-serif" font-size="36" font-weight="800">${spans}</text></svg>`);
  return sharp(overlay).png({compressionLevel:9,palette:true}).toBuffer();
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
