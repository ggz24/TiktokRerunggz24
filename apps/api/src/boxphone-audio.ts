import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LiveError, type LiveService } from './live-service.js';

const exec = promisify(execFile);
let extracting = false;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a request for audio of a library video (or of what a live channel is playing now) and extract it.
 * Ownership and readiness are resolved before any media process starts.
 */
export async function resolveBoxphoneAudio(
  service: LiveService,
  ownerId: string,
  body: { videoId?: unknown; accountId?: unknown; startSeconds?: unknown; seconds?: unknown },
) {
  let videoId = body.videoId;
  let start = body.startSeconds ?? 0;
  const requestedSeconds = body.seconds ?? 30;
  if (
    typeof requestedSeconds !== 'number' ||
    !Number.isFinite(requestedSeconds) ||
    requestedSeconds < 5 ||
    requestedSeconds > 60
  )
    throw new LiveError(400, 'Invalid audio segment.');
  let seconds = requestedSeconds;
  let target: {
    accountId: string;
    startedAt: string;
    videoId: string;
    roomId: string | null;
  } | null = null;
  if (body.accountId !== undefined) {
    if (typeof body.accountId !== 'string' || !uuidPattern.test(body.accountId))
      throw new LiveError(400, 'Invalid account ID.');
    const session = await service.session(ownerId, body.accountId);
    if (session.status !== 'live' || !session.videoId || !session.startedAt)
      throw new LiveError(409, 'The selected channel is not streaming.');
    videoId = session.videoId;
    // Use the recent played segment, not audio from a future part of the rerun.
    const played = (Date.now() - Date.parse(session.startedAt)) / 1000 - 8;
    if (!Number.isFinite(played) || played < 5)
      throw new LiveError(409, 'Waiting for the first played audio segment.');
    seconds = Math.min(seconds, played);
    start = Math.max(0, played - seconds);
    target = {
      accountId: body.accountId,
      startedAt: session.startedAt,
      videoId: session.videoId,
      roomId: await service.currentRoomId(ownerId, body.accountId),
    };
  }
  if (
    typeof videoId !== 'string' ||
    !uuidPattern.test(videoId) ||
    typeof start !== 'number' ||
    typeof seconds !== 'number'
  )
    throw new LiveError(400, 'Invalid video segment.');
  const file = await service.videoFile(ownerId, videoId);
  const audio = await extractBoxphoneAudio(file.path, start, seconds, !!target);
  return { ...audio, videoId, videoName: file.name, target };
}

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
