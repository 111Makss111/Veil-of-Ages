import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export const MAX_DURATION = 300;
export const MAX_OUTPUT_BYTES = 47 * 1024 * 1024;
export type CinematicPreset = 'ancient-mist' | 'ember-glow' | 'moonlit-ruins';
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

export function runMediaTool(binary: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const kill = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(kill, timeout);
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 1024 * 1024) kill(); });
    child.stderr.on('data', () => {}); // Never expose local paths or media metadata in logs.
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', kill);
      if (failed || code !== 0) reject(new Error('Не вдалося обробити медіа: перевірте файл, FFmpeg або обмеження часу.'));
      else resolve(output);
    });
  });
}

export async function checkMediaTools(): Promise<void> {
  await runMediaTool(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], 5000);
  await runMediaTool(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], 5000);
}

export function buildCinematicFilters(width: number, height: number, duration: number, preset: CinematicPreset) {
  const fadeIn = Math.min(2.5, Math.max(0.25, duration / 5));
  const fadeOut = Math.min(5, Math.max(0.5, duration / 4));
  const fadeOutAt = Math.max(0, duration - fadeOut);
  const looks: Record<CinematicPreset, { saturation: number; gamma: number; red: number; green: number; blue: number; mist: number; drift: number }> = {
    'ancient-mist': { saturation: .70, gamma: .96, red: -.025, green: .015, blue: .018, mist: .12, drift: 26 },
    'ember-glow': { saturation: .86, gamma: .95, red: .035, green: .005, blue: -.035, mist: .065, drift: 16 },
    'moonlit-ruins': { saturation: .62, gamma: .93, red: -.035, green: -.005, blue: .045, mist: .10, drift: 20 }
  };
  const look = looks[preset];
  const overscanWidth = Math.ceil(width * 1.2 / 2) * 2;
  const overscanHeight = Math.ceil(height * 1.2 / 2) * 2;
  const mistWidth = Math.ceil(width * 1.1 / 2) * 2;
  const mistHeight = Math.ceil(height * 1.1 / 2) * 2;
  const video = [
    `[0:v]scale=${overscanWidth}:${overscanHeight}:force_original_aspect_ratio=increase,crop=${overscanWidth}:${overscanHeight},`+
      `zoompan=z='min(max(zoom,pzoom)+0.000045,1.10)':x='iw/2-(iw/zoom/2)+18*sin(on/190)':y='ih/2-(ih/zoom/2)+11*cos(on/240)':d=1:s=${width}x${height}:fps=24,split=2[base][mist]`,
    `[base]eq=contrast=1.07:saturation=${look.saturation}:gamma=${look.gamma}:brightness='-0.032+0.006*sin(2*PI*t/7)+0.003*sin(2*PI*t/2.7)':eval=frame,`+
      `colorbalance=rs=${look.red}:gs=${look.green}:bs=${look.blue},vignette=PI/5[graded]`,
    `[mist]scale=${mistWidth}:${mistHeight},gblur=sigma=18:steps=1,hue=s=0,eq=brightness=.16:contrast=.48,format=rgba,colorchannelmixer=aa=${look.mist}[haze]`,
    `[graded][haze]overlay=x='-(overlay_w-main_w)/2+${look.drift}*sin(t/11)':y='-(overlay_h-main_h)/2+10*cos(t/13)':eval=frame,`+
      `noise=alls=1.8:allf=t+u,fade=t=in:st=0:d=${fadeIn.toFixed(3)},fade=t=out:st=${fadeOutAt.toFixed(3)}:d=${fadeOut.toFixed(3)},format=yuv420p[vout]`
  ].join(';');
  const audio = `[1:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${fadeOut.toFixed(3)}[aout]`;
  return { video, audio };
}

export async function renderMedia(image: string, audio: string, output: string, audioKind: string, signal?: AbortSignal, format: 'video' | 'shorts' = 'video', preset: CinematicPreset = 'ancient-mist'): Promise<void> {
  const probe = process.env.FFPROBE_PATH || 'ffprobe';
  const common = ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe'];
  const picture = JSON.parse(await runMediaTool(probe, [...common, '-f', 'image2', '-show_entries', 'stream=width,height', '-of', 'json', image], 15000, signal));
  const { width = 0, height = 0 } = picture.streams?.[0] ?? {};
  if (!width || !height || width * height > 12000000 || width > 6000 || height > 6000) throw new Error('Зображення завелике: максимум 12 мегапікселів і 6000 пікселів по стороні.');
  const sound = JSON.parse(await runMediaTool(probe, [...common, '-f', audioKind, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', audio], 15000, signal));
  const duration = Number(sound.format?.duration);
  if (!Number.isFinite(duration) || duration < 1 || duration > MAX_DURATION || !sound.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio')) throw new Error('Аудіо має тривати від 1 секунди до 5 хвилин.');
  const targetWidth = format === 'shorts' ? 720 : 1280;
  const targetHeight = format === 'shorts' ? 1280 : 720;
  const renderDuration = format === 'shorts' ? Math.min(duration, 60) : duration;
  const filters = buildCinematicFilters(targetWidth, targetHeight, renderDuration, preset);
  await runMediaTool(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-max_alloc', '67108864', '-filter_threads', '1',
    '-threads', '1', '-protocol_whitelist', 'file,pipe', '-f', 'image2', '-loop', '1', '-framerate', '24', '-i', image,
    '-threads', '1', '-protocol_whitelist', 'file,pipe', '-f', audioKind, '-i', audio,
    '-filter_complex', filters.video+';'+filters.audio, '-map', '[vout]', '-map', '[aout]', '-map_metadata', '-1',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '22', '-maxrate', '900k', '-bufsize', '1800k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-t', String(renderDuration), '-shortest', '-fs', String(MAX_OUTPUT_BYTES), '-movflags', '+faststart', output
  ], 20 * 60 * 1000, signal);
  const result = JSON.parse(await runMediaTool(probe, [...common, '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', output], 15000, signal));
  const size = (await stat(output)).size;
  const outputDuration = Number(result.format?.duration);
  if (size > MAX_OUTPUT_BYTES || !Number.isFinite(outputDuration) || Math.abs(outputDuration - renderDuration) > 0.5 || !result.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio') || !result.streams?.some((s: { width: number; height: number }) => s.width === targetWidth && s.height === targetHeight)) throw new Error('Результат не пройшов перевірку тривалості або розміру.');
}
