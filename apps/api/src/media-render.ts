import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export const MAX_DURATION = 300;
export const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
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

export async function renderMedia(image: string, audio: string, output: string, audioKind: string, signal?: AbortSignal): Promise<void> {
  const probe = process.env.FFPROBE_PATH || 'ffprobe';
  const common = ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe'];
  const picture = JSON.parse(await runMediaTool(probe, [...common, '-f', 'image2', '-show_entries', 'stream=width,height', '-of', 'json', image], 15000, signal));
  const { width = 0, height = 0 } = picture.streams?.[0] ?? {};
  if (!width || !height || width * height > 12000000 || width > 6000 || height > 6000) throw new Error('Зображення завелике: максимум 12 мегапікселів і 6000 пікселів по стороні.');
  const sound = JSON.parse(await runMediaTool(probe, [...common, '-f', audioKind, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', audio], 15000, signal));
  const duration = Number(sound.format?.duration);
  if (!Number.isFinite(duration) || duration < 1 || duration > MAX_DURATION || !sound.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio')) throw new Error('Аудіо має тривати від 1 секунди до 5 хвилин.');
  await runMediaTool(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-max_alloc', '67108864', '-filter_threads', '1',
    '-threads', '1', '-protocol_whitelist', 'file,pipe', '-f', 'image2', '-loop', '1', '-framerate', '24', '-i', image,
    '-threads', '1', '-protocol_whitelist', 'file,pipe', '-f', audioKind, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '23', '-maxrate', '400k', '-bufsize', '800k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-t', String(duration), '-shortest', '-fs', String(MAX_OUTPUT_BYTES), '-movflags', '+faststart', output
  ], 10 * 60 * 1000, signal);
  const result = JSON.parse(await runMediaTool(probe, [...common, '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', output], 15000, signal));
  const size = (await stat(output)).size;
  const outputDuration = Number(result.format?.duration);
  if (size > MAX_OUTPUT_BYTES || !Number.isFinite(outputDuration) || Math.abs(outputDuration - duration) > 0.5 || !result.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio') || !result.streams?.some((s: { width: number; height: number }) => s.width === 1280 && s.height === 720)) throw new Error('Результат не пройшов перевірку тривалості або розміру.');
}
