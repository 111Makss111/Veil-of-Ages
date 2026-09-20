import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { ACTIVE_EFFECT_IDS, motionProfiles, type FactoryEffectId, type MotionIntensity } from './factory-effects.js';

export const MAX_DURATION = 300;
export const MAX_OUTPUT_BYTES = 47 * 1024 * 1024;
export const SHORTS_DURATION = 30;
export function shortsClip(duration:number){const length=Math.min(SHORTS_DURATION,duration);return {start:duration<=length?0:Math.min(duration-length,Math.max(0,duration*.55-length/2)),duration:length};}
export type CinematicPreset = 'ancient-mist' | 'ember-glow' | 'moonlit-ruins';
export type MediaProgress = { percent: number; seconds: number; duration: number };
export type ShortsLyricOverlay = { path:string; start:number; end:number };
export type VideoLyricTrack = { manifestPath:string; cueCount:number };
export class MediaToolError extends Error {
  constructor(public reason: 'timeout'|'stalled'|'aborted'|'spawn'|'exit'|'output') {
    super('Не вдалося обробити медіа: перевірте файл, FFmpeg або обмеження часу.');
  }
}
export function mediaKind(header: Buffer, image: boolean): string {
  if (image) {
    if (header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
    if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'jpg';
  } else {
    if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE') return 'wav';
    if (header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 255 && ((header[1] ?? 0) & 224) === 224)) return 'mp3';
  }
  throw new Error(image ? 'Потрібне зображення JPG або PNG.' : 'Потрібне аудіо MP3 або WAV.');
}

export function videoKind(header: Buffer): 'mp4'|'webm' {
  if (header.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (header.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return 'webm';
  throw new Error('Потрібен відеофрагмент MP4 або WebM.');
}

export function runMediaTool(binary: string, args: string[], timeout: number, signal?: AbortSignal, onStdout?: (chunk: string) => void, inactivityTimeout=0): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', reason: MediaToolError['reason']|undefined;
    const kill = (why: MediaToolError['reason']) => { if (!reason) reason = why; child.kill('SIGKILL'); };
    const timer = setTimeout(() => kill('timeout'), timeout);
    let inactivityTimer:NodeJS.Timeout|undefined;
    const expectProgress=()=>{if(!inactivityTimeout)return;if(inactivityTimer)clearTimeout(inactivityTimer);inactivityTimer=setTimeout(()=>kill('stalled'),inactivityTimeout);};
    expectProgress();
    const abort = () => kill('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      expectProgress();
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      else { output += text; if (output.length > 1024 * 1024) kill('output'); }
    });
    child.stderr.on('data', () => {}); // Never expose local paths or media metadata in logs.
    child.once('error', () => { reason = 'spawn'; });
    child.once('close', code => {
      clearTimeout(timer);if(inactivityTimer)clearTimeout(inactivityTimer); signal?.removeEventListener('abort', abort);
      if (reason || code !== 0) reject(new MediaToolError(reason ?? 'exit'));
      else resolve(output);
    });
  });
}

export async function checkMediaTools(): Promise<void> {
  await runMediaTool(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], 5000);
  await runMediaTool(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], 5000);
}

export function rhythmPulsesFromAstats(value:string,duration:number):number[]{
  const samples:Array<{time:number;db:number}>=[];let time=0;
  for(const line of value.split(/\r?\n/)){
    const timeMatch=/pts_time:([\d.]+)/.exec(line);if(timeMatch)time=Number(timeMatch[1]);
    const level=/lavfi\.astats\.Overall\.RMS_level=(-?(?:\d+(?:\.\d+)?|inf))/i.exec(line);
    if(level&&Number.isFinite(time)){const db=level[1]!.toLowerCase()==='-inf'?-120:Number(level[1]);if(Number.isFinite(db)&&time>=0&&time<duration)samples.push({time,db});}
  }
  if(samples.length<8)return [];
  const levels=samples.map(sample=>sample.db).sort((a,b)=>a-b),floor=levels[Math.floor(levels.length*.35)]??-60,candidates:Array<{time:number;score:number}>=[];
  for(let index=3;index<samples.length-1;index++){
    const current=samples[index]!,previous=(samples[index-1]!.db+samples[index-2]!.db+samples[index-3]!.db)/3,rise=current.db-previous;
    if(current.db<samples[index-1]!.db||current.db<samples[index+1]!.db||(rise<1.4&&current.db<floor+8))continue;
    const score=rise+Math.max(0,current.db-floor)*.18,last=candidates.at(-1);
    if(last&&current.time-last.time<.16){if(score>last.score)candidates[candidates.length-1]={time:current.time,score};}
    else candidates.push({time:current.time,score});
  }
  return candidates.slice(0,180).map(item=>Number(item.time.toFixed(3)));
}

export async function analyzeShortsRhythm(audio:string,audioKind:string,clipStart:number,duration:number,signal?:AbortSignal):Promise<number[]>{
  const output=await runMediaTool(process.env.FFMPEG_PATH||'ffmpeg',[
    '-hide_banner','-loglevel','error','-nostdin','-f',audioKind,'-ss',Math.max(0,clipStart).toFixed(3),'-t',Math.max(1,duration).toFixed(3),'-i',audio,
    '-vn','-af','aresample=8000,asetnsamples=n=400,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-'
  ],2*60*1000,signal);
  return rhythmPulsesFromAstats(output,duration);
}

export function buildCinematicFilters(width: number, height: number, duration: number, preset: CinematicPreset, intensity:MotionIntensity='cinematic', effects:ReadonlyArray<FactoryEffectId>=ACTIVE_EFFECT_IDS, sceneCount=1, lyricOverlays:ReadonlyArray<ShortsLyricOverlay>=[],videoLyrics=false) {
  const fadeIn = Math.min(2.5, Math.max(0.25, duration / 5));
  const fadeOut = Math.min(5, Math.max(0.5, duration / 4));
  const fadeOutAt = Math.max(0, duration - fadeOut);
  const looks: Record<CinematicPreset, { saturation: number; gamma: number; red: number; green: number; blue: number; mist: number; drift: number }> = {
    'ancient-mist': { saturation: .70, gamma: .96, red: -.025, green: .015, blue: .018, mist: .15, drift: 32 },
    'ember-glow': { saturation: .86, gamma: .95, red: .035, green: .005, blue: -.035, mist: .085, drift: 22 },
    'moonlit-ruins': { saturation: .62, gamma: .93, red: -.035, green: -.005, blue: .045, mist: .13, drift: 27 }
  };
  const look = looks[preset];
  const motion=motionProfiles[intensity];
  const has=(effect:FactoryEffectId)=>effects.includes(effect);
  const count=Math.max(1,Math.min(3,Math.round(sceneCount)));
  const transition=Math.min(1.5,Math.max(.35,duration/10));
  const segment=(duration+transition*(count-1))/count;
  const frames = Math.max(24, Math.round(segment * 24));
  const overscanWidth = Math.ceil(width * 1.2 / 2) * 2;
  const overscanHeight = Math.ceil(height * 1.2 / 2) * 2;
  const mistWidth = Math.ceil(width * 1.1 / 2) * 2;
  const mistHeight = Math.ceil(height * 1.1 / 2) * 2;
  const hazeWidth = Math.ceil(width / 4 / 2) * 2;
  const hazeHeight = Math.ceil(height / 4 / 2) * 2;
  const video:string[]=[];
  const sceneOutputs:string[]=[];
  for(let index=0;index<count;index++){
    const source=`scene${index}`,base=`base${index}`,graded=`graded${index}`;
    const fitted=has('camera.center-push')
      ?`scale=${overscanWidth}:${overscanHeight}:force_original_aspect_ratio=increase,crop=${overscanWidth}:${overscanHeight},zoompan=z='1+${motion.zoom.toFixed(3)}*on/${frames}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=${width}x${height}:fps=24`
      :`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=24`;
    video.push(`[${index}:v]trim=duration=${segment.toFixed(3)},setpts=PTS-STARTPTS,${fitted},settb=AVTB${has('atmosphere.moving-mist')?`,split=2[${source}][mistseed${index}]`:`[${source}]`}`);
    const grade:string[]=[];
    if(has('look.dark-fantasy-grade'))grade.push(`eq=contrast=1.07:saturation=${look.saturation}:gamma=${look.gamma}:brightness=-0.032`,`colorbalance=rs=${look.red}:gs=${look.green}:bs=${look.blue}`);
    if(has('light.global-breathing'))grade.push(`eq=brightness='${has('look.dark-fantasy-grade')?'0':-0.032}+${(0.006*motion.light).toFixed(4)}*sin(2*PI*t/7)+${(0.003*motion.light).toFixed(4)}*sin(2*PI*t/2.7)':eval=frame`);
    video.push(`[${source}]${grade.length?grade.join(','):'null'}[${graded}]`);
    let composed=graded;
    if(has('atmosphere.moving-mist')){
      video.push(`[mistseed${index}]scale=${hazeWidth}:${hazeHeight}:force_original_aspect_ratio=increase,crop=${hazeWidth}:${hazeHeight},gblur=sigma=8:steps=1,hue=s=0,eq=brightness=.18:contrast=.44,scale=${mistWidth}:${mistHeight}:flags=bilinear,format=rgba,colorchannelmixer=aa=${Math.min(.24,look.mist*motion.mist*1.25).toFixed(4)}[haze${index}]`);
      video.push(`[${graded}][haze${index}]overlay=x='-(overlay_w-main_w)/2+${look.drift}*sin(t/7)':y='-(overlay_h-main_h)/2+14*cos(t/9)':eval=frame[misted${index}]`);
      composed=`misted${index}`;
    }
    if(has('atmosphere.drifting-particles')){
      const particleLook=preset==='ember-glow'?',colorbalance=rs=.45:gs=.08:bs=-.35':'';
      video.push(`color=c=black:s=${hazeWidth}x${hazeHeight}:r=24:d=${segment.toFixed(3)},noise=alls=85:allf=u,lutyuv=y='if(gt(val,247),255,0)':u=128:v=128,scroll=vertical=${preset==='ember-glow'?'-.004':'.006'},gblur=sigma=.35,scale=${width}:${height}:flags=bilinear${particleLook}[particles${index}]`);
      video.push(`[${composed}][particles${index}]blend=all_mode=screen:all_opacity=${Math.min(.28,.16*motion.particles).toFixed(3)}[alive${index}]`);
      composed=`alive${index}`;
    }
    video.push(`[${composed}]format=yuv420p[shot${index}]`);
    sceneOutputs.push(`shot${index}`);
  }
  let composed=sceneOutputs[0]!;
  if(count>1&&has('transition.scene-crossfades')){
    for(let index=1;index<count;index++){
      const next=index===count-1?'story':`cross${index}`;
      video.push(`[${composed}][${sceneOutputs[index]}]xfade=transition=fade:duration=${transition.toFixed(3)}:offset=${(index*(segment-transition)).toFixed(3)}[${next}]`);
      composed=next;
    }
  }else if(count>1){
    video.push(sceneOutputs.map(value=>`[${value}]`).join('')+`concat=n=${count}:v=1:a=0[story]`);
    composed='story';
  }
  for(const [index,cue] of lyricOverlays.entries()){
    const input=count+index,next=`captioned${index}`;
    video.push(`[${input}:v]format=rgba[caption${index}]`);
    const direction=index%2===0?-85:85,start=cue.start.toFixed(3),end=cue.end.toFixed(3),span=Math.max(.1,cue.end-cue.start).toFixed(3);
    video.push(`[${composed}][caption${index}]overlay=x='(main_w-overlay_w)/2+if(lt(t,${start}+.18),(${start}+.18-t)*${direction},0)':y='530-12*sin((t-${start})*PI/${span})':enable='between(t,${start},${end})':eof_action=pass[${next}]`);
    composed=next;
  }
  if(videoLyrics){
    const input=count+lyricOverlays.length;
    video.push(`[${input}:v]fps=24,setpts=PTS-STARTPTS,format=rgba[lyrictrack]`);
    const lyricPosition=height>width?"x='(main_w-overlay_w)/2+8*sin(t*5)':y='530-10*sin(t*7)'":'x=0:y=0';
    video.push(`[${composed}][lyrictrack]overlay=${lyricPosition}:eof_action=pass:shortest=0[lyricvideo]`);
    composed='lyricvideo';
  }
  const finish:string[]=[];
  if(has('framing.vignette'))finish.push(`vignette=${motion.vignette}`);
  if(has('texture.film-grain'))finish.push(`noise=alls=${(1.2*motion.grain).toFixed(2)}:allf=u`);
  if(has('transition.soft-fades'))finish.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`,`fade=t=out:st=${fadeOutAt.toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  finish.push('format=yuv420p');
  video.push(`[${composed}]${finish.join(',')}[vout]`);
  const audioFilters:string[]=[];
  if(has('audio.loudness-master'))audioFilters.push('loudnorm=I=-14:TP=-1.5:LRA=11');
  audioFilters.push('aresample=48000');
  if(has('transition.soft-fades'))audioFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`,`afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  const audio = `[${count+lyricOverlays.length+(videoLyrics?1:0)}:a]${audioFilters.join(',')}[aout]`;
  return { video:video.join(';'), audio };
}

export async function renderMedia(image: string|string[], audio: string, output: string, audioKind: string, signal?: AbortSignal, format: 'video' | 'shorts' = 'video', preset: CinematicPreset = 'ancient-mist', onProgress?: (progress: MediaProgress) => void, intensity:MotionIntensity='cinematic', effects:ReadonlyArray<FactoryEffectId>=ACTIVE_EFFECT_IDS, lyricOverlays:ReadonlyArray<ShortsLyricOverlay>=[],videoLyricTrack?:VideoLyricTrack|null,sourceClip?:{start:number;duration:number}): Promise<void> {
  const probe = process.env.FFPROBE_PATH || 'ffprobe';
  const common = ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe'];
  const images=Array.isArray(image)?image:[image];
  if(images.length<1||images.length>3)throw new Error('Для монтажу потрібно від одного до трьох зображень.');
  for(const pictureFile of images){
    const picture = JSON.parse(await runMediaTool(probe, [...common, '-f', 'image2', '-show_entries', 'stream=width,height', '-of', 'json', pictureFile], 15000, signal));
    const { width = 0, height = 0 } = picture.streams?.[0] ?? {};
    if (!width || !height || width * height > 12000000 || width > 6000 || height > 6000) throw new Error('Зображення завелике: максимум 12 мегапікселів і 6000 пікселів по стороні.');
  }
  const sound = JSON.parse(await runMediaTool(probe, [...common, '-f', audioKind, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', audio], 15000, signal));
  const duration = Number(sound.format?.duration);
  if (!Number.isFinite(duration) || duration < 1 || duration > MAX_DURATION || !sound.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio')) throw new Error('Аудіо має тривати від 1 секунди до 5 хвилин.');
  const targetWidth = format === 'shorts' ? 720 : 1280;
  const targetHeight = format === 'shorts' ? 1280 : 720;
  const requested=format==='shorts'&&sourceClip?sourceClip:format==='shorts'?shortsClip(duration):{start:0,duration};
  const clip={start:Math.max(0,Math.min(duration-1,Number(requested.start)||0)),duration:Math.min(duration,Math.max(1,Number(requested.duration)||duration))};
  clip.duration=Math.min(clip.duration,duration-clip.start);
  const renderDuration = clip.duration;
  const captions=format==='shorts'?lyricOverlays.filter(cue=>Number.isFinite(cue.start)&&Number.isFinite(cue.end)&&cue.start>=0&&cue.end>cue.start&&cue.start<renderDuration).slice(0,30):[];
  const timedLyrics=!!videoLyricTrack;
  const filters = buildCinematicFilters(targetWidth, targetHeight, renderDuration, preset,intensity,effects,images.length,captions,timedLyrics);
  let progressBuffer='';
  const parseProgress=(chunk:string)=>{
    progressBuffer+=chunk;
    const lines=progressBuffer.split(/\r?\n/);progressBuffer=lines.pop()??'';
    for(const line of lines){
      const match=/^out_time_us=(\d+)$/.exec(line);
      if(match){const seconds=Math.min(renderDuration,Number(match[1])/1_000_000);onProgress?.({seconds,duration:renderDuration,percent:Math.min(100,Math.max(0,seconds/renderDuration*100))});}
    }
  };
  const imageInputs=images.flatMap(pictureFile=>['-protocol_whitelist','file,pipe','-f','image2','-loop','1','-framerate','24','-i',pictureFile]);
  const lyricInputs=captions.flatMap(cue=>['-protocol_whitelist','file,pipe','-f','image2','-loop','1','-framerate','24','-i',cue.path]);
  const videoLyricInput=timedLyrics?['-protocol_whitelist','file,pipe','-f','concat','-safe','0','-i',videoLyricTrack!.manifestPath]:[];
  const useNvenc=process.env.LOCAL_VIDEO_ENCODER==='h264_nvenc',threads=String(Math.max(1,Math.min(8,Number(process.env.MEDIA_THREADS)||1)));
  const videoCodec=useNvenc?['-c:v','h264_nvenc','-preset','p4','-tune','hq','-rc','vbr','-cq','23','-b:v','0','-maxrate','900k','-bufsize','1800k']:['-c:v','libx264','-threads',threads,'-preset','superfast','-crf','22','-maxrate','900k','-bufsize','1800k'];
  await runMediaTool(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-max_alloc', '67108864', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...imageInputs,...lyricInputs,...videoLyricInput,
    '-protocol_whitelist', 'file,pipe', '-f', audioKind, ...(format==='shorts'&&clip.start>0?['-ss',clip.start.toFixed(3)]:[]), '-i', audio,
    '-filter_complex', filters.video+';'+filters.audio, '-map', '[vout]', '-map', '[aout]', '-map_metadata', '-1',
    ...videoCodec, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-t', String(renderDuration), '-shortest', '-fs', String(MAX_OUTPUT_BYTES), '-movflags', '+faststart',
    '-progress','pipe:1','-nostats',output
  ], 90 * 60 * 1000, signal, parseProgress,5*60*1000);
  const result = JSON.parse(await runMediaTool(probe, [...common, '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', output], 15000, signal));
  const size = (await stat(output)).size;
  const outputDuration = Number(result.format?.duration);
  if (size > MAX_OUTPUT_BYTES || !Number.isFinite(outputDuration) || Math.abs(outputDuration - renderDuration) > 0.5 || !result.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio') || !result.streams?.some((s: { width: number; height: number }) => s.width === targetWidth && s.height === targetHeight)) throw new Error('Результат не пройшов перевірку тривалості або розміру.');
}

/**
 * Assemble user-generated vertical clips into a short. The sequence is
 * normalized into equal scene windows when all six story clips are present.
 * Longer clips are trimmed and shorter clips hold their final frame, so every
 * prompt remains visible in the finished 30-second story. Each input is
 * scaled/cropped in the stream, so Render does not hold decoded clips in memory.
 */
export async function renderVideoClips(clips: string[], clipDurations: number[], audio: string, output: string, audioKind: string, signal?: AbortSignal, onProgress?: (progress: MediaProgress) => void,lyricOverlays:ReadonlyArray<ShortsLyricOverlay>=[],sourceClip?:{start:number;duration:number},videoLyricTrack?:VideoLyricTrack|null): Promise<void> {
  if (clips.length < 1 || clips.length > 6 || clips.length !== clipDurations.length) throw new Error('Потрібно від одного до шести відеофрагментів.');
  const probe = process.env.FFPROBE_PATH || 'ffprobe';
  const common = ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe'];
  const sound = JSON.parse(await runMediaTool(probe, [...common, '-f', audioKind, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', audio], 15000, signal));
  const audioDuration = Number(sound.format?.duration);
  if (!Number.isFinite(audioDuration) || audioDuration < 1 || audioDuration > MAX_DURATION || !sound.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio')) throw new Error('Аудіо має тривати від 1 секунди до 5 хвилин.');
  const requested=sourceClip??shortsClip(audioDuration),clipStart=Math.max(0,Math.min(audioDuration-1,Number(requested.start)||0));
  const clipWindow = Math.min(SHORTS_DURATION,audioDuration-clipStart,Math.max(1,Number(requested.duration)||SHORTS_DURATION));
  const validDurations = clipDurations.map(value => Number.isFinite(value) && value > 0 ? Math.min(value, 60) : 0);
  if (validDurations.some(value => value < 0.25) || validDurations.reduce((sum, value) => sum + value, 0) < 0.25) throw new Error('Один із відеофрагментів не має коректної тривалості.');
  const sequence: Array<{ index: number; duration: number }> = clips.length===6
    ? clips.map((_clip,index)=>({index,duration:clipWindow/6}))
    : [];
  let elapsed=sequence.reduce((sum,segment)=>sum+segment.duration,0),cursor=0;
  while (elapsed < clipWindow - 0.01 && sequence.length < 24) {
    const duration = Math.min(validDurations[cursor]!, clipWindow - elapsed);
    sequence.push({ index: cursor, duration }); elapsed += duration; cursor = (cursor + 1) % clips.length;
  }
  if (!sequence.length) throw new Error('Відеофрагменти порожні.');
  const filters = sequence.map((segment, index) => `[${index}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=${segment.duration.toFixed(3)},trim=duration=${segment.duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`);
  filters.push(sequence.map((_segment, index) => `[v${index}]`).join('') + `concat=n=${sequence.length}:v=1:a=0[story]`);
  const captions=lyricOverlays.filter(cue=>Number.isFinite(cue.start)&&Number.isFinite(cue.end)&&cue.start>=0&&cue.end>cue.start&&cue.start<clipWindow).slice(0,30);
  let composed='story';
  captions.forEach((cue,index)=>{const input=sequence.length+index,next=`captioned${index}`,direction=index%2===0?-85:85,start=cue.start.toFixed(3),end=cue.end.toFixed(3),span=Math.max(.1,cue.end-cue.start).toFixed(3);filters.push(`[${input}:v]format=rgba[caption${index}]`);filters.push(`[${composed}][caption${index}]overlay=x='(main_w-overlay_w)/2+if(lt(t,${start}+.18),(${start}+.18-t)*${direction},0)':y='530-12*sin((t-${start})*PI/${span})':enable='between(t,${start},${end})':eof_action=pass[${next}]`);composed=next;});
  if(videoLyricTrack){const input=sequence.length+captions.length;filters.push(`[${input}:v]fps=24,setpts=PTS-STARTPTS,format=rgba[lyrictrack]`);filters.push(`[${composed}][lyrictrack]overlay=x='(main_w-overlay_w)/2+8*sin(t*5)':y='530-10*sin(t*7)':eof_action=pass:shortest=0[lyricvideo]`);composed='lyricvideo';}
  filters.push(`[${composed}]null[vout]`);
  const audioInputIndex = sequence.length+captions.length+(videoLyricTrack?1:0);
  filters.push(`[${audioInputIndex}:a]aresample=48000,afade=t=in:st=0:d=${Math.min(1.5,clipWindow / 5).toFixed(3)},afade=t=out:st=${Math.max(0,clipWindow - Math.min(2,clipWindow / 4)).toFixed(3)}:d=${Math.min(2,clipWindow / 4).toFixed(3)}[aout]`);
  let progressBuffer = '';
  const parseProgress = (chunk: string) => {
    progressBuffer += chunk; const lines = progressBuffer.split(/\r?\n/); progressBuffer = lines.pop() ?? '';
    for (const line of lines) { const match = /^out_time_us=(\d+)$/.exec(line); if (match) { const seconds = Math.min(clipWindow, Number(match[1]) / 1_000_000); onProgress?.({ seconds, duration: clipWindow, percent: Math.min(100, Math.max(0, seconds / clipWindow * 100)) }); } }
  };
  const inputArgs = sequence.flatMap(segment => ['-protocol_whitelist', 'file,pipe', '-i', clips[segment.index]!]);
  const lyricInputs=captions.flatMap(cue=>['-protocol_whitelist','file,pipe','-f','image2','-loop','1','-framerate','24','-i',cue.path]);
  const videoLyricInput=videoLyricTrack?['-protocol_whitelist','file,pipe','-f','concat','-safe','0','-i',videoLyricTrack.manifestPath]:[];
  const useNvenc = process.env.LOCAL_VIDEO_ENCODER === 'h264_nvenc';
  const threads = String(Math.max(1, Math.min(8, Number(process.env.MEDIA_THREADS) || 1)));
  const videoCodec = useNvenc ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-maxrate', '900k', '-bufsize', '1800k'] : ['-c:v', 'libx264', '-threads', threads, '-preset', 'superfast', '-crf', '22', '-maxrate', '900k', '-bufsize', '1800k'];
  await runMediaTool(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-max_alloc', '67108864', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...inputArgs,...lyricInputs,...videoLyricInput, '-protocol_whitelist', 'file,pipe', '-f', audioKind, ...(clipStart>0?['-ss',clipStart.toFixed(3)]:[]), '-i', audio,
    '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-map_metadata', '-1', ...videoCodec, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-t', String(clipWindow), '-shortest', '-fs', String(MAX_OUTPUT_BYTES), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output
  ], 90 * 60 * 1000, signal, parseProgress, 5 * 60 * 1000);
  const result = JSON.parse(await runMediaTool(probe, [...common, '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', output], 15000, signal));
  const size = (await stat(output)).size, outputDuration = Number(result.format?.duration);
  if (size > MAX_OUTPUT_BYTES || !Number.isFinite(outputDuration) || Math.abs(outputDuration - clipWindow) > 0.5 || !result.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio') || !result.streams?.some((s: { width: number; height: number }) => s.width === 720 && s.height === 1280)) throw new Error('Результат зі відеофрагментів не пройшов перевірку.');
}
