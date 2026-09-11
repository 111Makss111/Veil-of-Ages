import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { ACTIVE_EFFECT_IDS, motionProfiles, type FactoryEffectId, type MotionIntensity } from './factory-effects.js';

export const MAX_DURATION = 300;
export const MAX_OUTPUT_BYTES = 47 * 1024 * 1024;
export type CinematicPreset = 'ancient-mist' | 'ember-glow' | 'moonlit-ruins';
export type MediaProgress = { percent: number; seconds: number; duration: number };
export class MediaToolError extends Error {
  constructor(public reason: 'timeout'|'aborted'|'spawn'|'exit'|'output') {
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

export function runMediaTool(binary: string, args: string[], timeout: number, signal?: AbortSignal, onStdout?: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', reason: MediaToolError['reason']|undefined;
    const kill = (why: MediaToolError['reason']) => { if (!reason) reason = why; child.kill('SIGKILL'); };
    const timer = setTimeout(() => kill('timeout'), timeout);
    const abort = () => kill('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      else { output += text; if (output.length > 1024 * 1024) kill('output'); }
    });
    child.stderr.on('data', () => {}); // Never expose local paths or media metadata in logs.
    child.once('error', () => { reason = 'spawn'; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (reason || code !== 0) reject(new MediaToolError(reason ?? 'exit'));
      else resolve(output);
    });
  });
}

export async function checkMediaTools(): Promise<void> {
  await runMediaTool(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], 5000);
  await runMediaTool(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], 5000);
}

export function buildCinematicFilters(width: number, height: number, duration: number, preset: CinematicPreset, intensity:MotionIntensity='cinematic', effects:ReadonlyArray<FactoryEffectId>=ACTIVE_EFFECT_IDS, sceneCount=1) {
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
    const fitted=has('camera.center-push')&&count===1
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
  const audio = `[${count}:a]${audioFilters.join(',')}[aout]`;
  return { video:video.join(';'), audio };
}

export async function renderMedia(image: string|string[], audio: string, output: string, audioKind: string, signal?: AbortSignal, format: 'video' | 'shorts' = 'video', preset: CinematicPreset = 'ancient-mist', onProgress?: (progress: MediaProgress) => void, intensity:MotionIntensity='cinematic', effects:ReadonlyArray<FactoryEffectId>=ACTIVE_EFFECT_IDS): Promise<void> {
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
  const renderDuration = format === 'shorts' ? Math.min(duration, 60) : duration;
  const filters = buildCinematicFilters(targetWidth, targetHeight, renderDuration, preset,intensity,effects,images.length);
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
  await runMediaTool(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-max_alloc', '67108864', '-filter_complex_threads', '2',
    ...imageInputs,
    '-protocol_whitelist', 'file,pipe', '-f', audioKind, '-i', audio,
    '-filter_complex', filters.video+';'+filters.audio, '-map', '[vout]', '-map', '[aout]', '-map_metadata', '-1',
    '-c:v', 'libx264', '-threads', '2', '-preset', 'superfast', '-crf', '22', '-maxrate', '900k', '-bufsize', '1800k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-t', String(renderDuration), '-shortest', '-fs', String(MAX_OUTPUT_BYTES), '-movflags', '+faststart',
    '-progress','pipe:1','-nostats',output
  ], 90 * 60 * 1000, signal, parseProgress);
  const result = JSON.parse(await runMediaTool(probe, [...common, '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', output], 15000, signal));
  const size = (await stat(output)).size;
  const outputDuration = Number(result.format?.duration);
  if (size > MAX_OUTPUT_BYTES || !Number.isFinite(outputDuration) || Math.abs(outputDuration - renderDuration) > 0.5 || !result.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio') || !result.streams?.some((s: { width: number; height: number }) => s.width === targetWidth && s.height === targetHeight)) throw new Error('Результат не пройшов перевірку тривалості або розміру.');
}
