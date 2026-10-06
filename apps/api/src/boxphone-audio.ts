import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LiveError } from './live-service.js';

const exec = promisify(execFile);
let extracting = false;

export function audioWindow(duration: number, start: number, seconds: number, loop: boolean) {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(seconds) ||
    seconds < 5 ||
    seconds > 60
  )
    throw new LiveError(400, 'Invalid audio segment.');
  if (!loop && start >= duration)
    throw new LiveError(422, 'Audio start is past the end of the video.');
  return { start: loop ? start % duration : start, seconds, duration };
}

/** Extract one bounded audio segment. Never accept a client supplied file path or URL. */
export async function extractBoxphoneAudio(
  file: string,
  start: number,
  seconds: number,
  loop: boolean,
) {
  if (extracting) throw new LiveError(409, 'Audio extraction is busy. Try again shortly.');
  extracting = true;
  try {
    const probe = await exec(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        file,
      ],
      { timeout: 15000, maxBuffer: 4096, windowsHide: true },
    );
    const window = audioWindow(Number(probe.stdout.trim()), start, seconds, loop);
    const result = await exec(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...(loop ? ['-stream_loop', '-1'] : []),
        '-ss',
        String(window.start),
        '-i',
        file,
        '-t',
        String(seconds),
        '-vn',
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '48k',
        '-threads',
        '1',
        '-f',
        'mp3',
        'pipe:1',
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'buffer', windowsHide: true },
    );
    if (result.stdout.length < 128) throw new LiveError(422, 'No audio in this video segment.');
    return {
      audio: result.stdout.toString('base64'),
      name: 'library-segment.mp3',
      mime: 'audio/mpeg',
      startSeconds: window.start,
      seconds,
      durationSeconds: window.duration,
    };
  } catch (error) {
    if (error instanceof LiveError) throw error;
    throw new LiveError(422, 'Could not extract audio. Check that the video has an audio track.');
  } finally {
    extracting = false;
  }
}
