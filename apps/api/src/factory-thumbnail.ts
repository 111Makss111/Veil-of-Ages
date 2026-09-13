import sharp from 'sharp';

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
