import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decryptAccountCookie, decryptAccountUserAgent, type AccountStore } from './accounts.js';
import type { EncryptedValue, LiveConfigRow, LiveStore, LiveVideo } from './live-store.js';

export const MAX_VIDEO_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_OWNER_VIDEO_BYTES = 40 * 1024 * 1024 * 1024;
export const MAX_OWNER_VIDEOS = 100;

export class LiveError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type LiveStatus = 'idle' | 'starting' | 'live' | 'stopping' | 'failed';

export interface LiveSession {
  accountId: string;
  status: LiveStatus;
  hasRtmpConfig: boolean;
  hasOpenRoom: boolean;
  videoId?: string;
  videoName?: string;
  startedAt?: string;
  error?: string;
}

export type AutoRoomCreator = (input: {
  title: string;
  cookieHeader: string;
  userAgent?: string;
}) => Promise<{ roomId: string; streamId: string; rtmpUrl: string; streamKey: string }>;

export type AutoRoomEnder = (input: {
  cookieHeader: string;
  userAgent?: string;
  roomId?: string | null;
  streamId?: string | null;
}) => Promise<'ended' | 'no_room'>;

export type AutoRoomChecker = (input: {
  cookieHeader: string;
  userAgent?: string;
  roomId: string;
  streamId?: string | null;
}) => Promise<'open' | 'closed'>;

// A destination is only an FFmpeg output target. Resolving one does not prove that
// a platform room exists or that the stream is visible to viewers.
export interface LiveDestinationProvider {
  resolve(input: {
    ownerId: string;
    accountId: string;
    config: LiveConfigRow;
  }): Promise<{ url: string }>;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type VideoTracks = { videoCodec: string; audioCodec: string };
type ProbeFn = (path: string) => Promise<boolean | VideoTracks>;
type ConvertFn = (source: string, destination: string) => Promise<void>;

interface RunningProcess {
  status: LiveStatus;
  child?: ChildProcess;
  startedAt?: string;
  error?: string;
  cancelled: boolean;
  stopTimer?: NodeJS.Timeout;
  startupTimer?: NodeJS.Timeout;
}

function encrypted(value: string, key: Buffer, aad: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const plaintext = Buffer.from(value, 'utf8');
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  } finally {
    plaintext.fill(0);
  }
}

function decrypted(value: EncryptedValue, key: Buffer, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, value.iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(value.tag);
  const plaintext = Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
  try {
    return plaintext.toString('utf8');
  } finally {
    plaintext.fill(0);
  }
}

export function createSavedRtmpDestinationProvider(encryptionKey: Buffer): LiveDestinationProvider {
  if (encryptionKey.length !== 32) throw new Error('Live encryption key must be 32 bytes.');
  return {
    async resolve({ ownerId, accountId, config }) {
      try {
        const rtmpUrl = decrypted(
          config.rtmpUrl,
          encryptionKey,
          `${ownerId}\0${accountId}\0rtmp-url`,
        );
        const streamKey = decrypted(
          config.streamKey,
          encryptionKey,
          `${ownerId}\0${accountId}\0stream-key`,
        );
        return { url: `${rtmpUrl.replace(/\/+$/, '')}/${streamKey}` };
      } catch {
        throw new LiveError(503, 'Live configuration is unavailable.');
      }
    },
  };
}

function validRtmpUrl(input: unknown): input is string {
  if (typeof input !== 'string' || input.length < 9 || input.length > 2048) return false;
  if (
    Array.from(input).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127 || character === '\\';
    })
  )
    return false;
  try {
    const url = new URL(input);
    return (
      (url.protocol === 'rtmp:' || url.protocol === 'rtmps:') &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search
    );
  } catch {
    return false;
  }
}

function validStreamKey(input: unknown): input is string {
  return (
    typeof input === 'string' &&
    input.length >= 1 &&
    input.length <= 2048 &&
    !Array.from(input).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127 || character === '\\' || character === '#';
    }) &&
    !input.includes('://')
  );
}

// FFmpeg can include the entire push URL (including the stream key) in stderr.
// Only return fixed messages inferred from it; never persist or return raw output.
function streamFailure(stderr: string): string {
  if (/operation not permitted|\b(?:401|403)\b|server error/i.test(stderr)) {
    return 'Streaming destination rejected the connection. Check that the LIVE room and key are still valid.';
  }
  if (/connection reset|broken pipe|connection timed out|i\/o error/i.test(stderr)) {
    return 'Connection to the streaming destination was interrupted.';
  }
  if (/error.*encoder|error while filtering|conversion failed/i.test(stderr)) {
    return 'Video encoding stopped unexpectedly.';
  }
  return 'Streaming process stopped unexpectedly.';
}

function validVideoName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name.toLowerCase().endsWith('.mp4') &&
    !Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || character === '\\' || character === '/';
    }) &&
    name !== '.' &&
    name !== '..'
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function mediaPath(mediaDir: string, videoId: string): string {
  if (!isUuid(videoId)) throw new LiveError(400, 'Invalid video ID.');
  const directory = resolve(mediaDir);
  const path = resolve(directory, `${videoId}.mp4`);
  if (!path.startsWith(`${directory}${sep}`)) throw new LiveError(400, 'Invalid video path.');
  return path;
}

export async function defaultProbeVideo(path: string): Promise<false | VideoTracks> {
  return new Promise((resolveResult) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', path],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false },
    );
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000);
    timeout.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 16_384) output += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolveResult(false);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return resolveResult(false);
      try {
        const parsed = JSON.parse(output) as {
          streams?: { codec_type?: string; codec_name?: string }[];
        };
        const streams = parsed.streams ?? [];
        const video = streams.find((stream) => stream.codec_type === 'video');
        const audio = streams.find((stream) => stream.codec_type === 'audio');
        resolveResult(
          video && audio
            ? {
                videoCodec: video.codec_name ?? '',
                audioCodec: audio.codec_name ?? '',
              }
            : false,
        );
      } catch {
        resolveResult(false);
      }
    });
  });
}

export async function defaultConvertVideo(source: string, destination: string): Promise<void> {
  await new Promise<void>((resolveResult, rejectResult) => {
    const child = spawn(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        source,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        destination,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false },
    );
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectResult(error);
      else resolveResult();
    };
    child.stderr?.resume();
    child.once('error', (error) => finish(error));
    child.once('close', (code) =>
      finish(code === 0 ? undefined : new Error('FFmpeg could not convert the uploaded video.')),
    );
  });
}

export class LiveService {
  private readonly processes = new Map<string, RunningProcess>();
  private readonly openingRooms = new Set<string>();
  private readonly deletingAccounts = new Set<string>();
  private readonly configuringAccounts = new Set<string>();
  private readonly destinationProvider: LiveDestinationProvider;

  constructor(
    private readonly store: LiveStore,
    private readonly accounts: AccountStore,
    private readonly encryptionKey: Buffer,
    private readonly mediaDir: string,
    private readonly spawnProcess: SpawnFn = spawn,
    private readonly probeVideo: ProbeFn = defaultProbeVideo,
    destinationProvider?: LiveDestinationProvider,
    private readonly autoRoomCreator?: AutoRoomCreator,
    private readonly autoRoomEnder?: AutoRoomEnder,
    private readonly autoRoomChecker?: AutoRoomChecker,
    private readonly maxConcurrentStreams: number | null = null,
    private readonly convertVideo: ConvertFn = defaultConvertVideo,
  ) {
    if (encryptionKey.length !== 32) throw new Error('Live encryption key must be 32 bytes.');
    if (
      maxConcurrentStreams !== null &&
      (!Number.isInteger(maxConcurrentStreams) || maxConcurrentStreams < 1)
    )
      throw new Error('Live concurrency limit must be a positive integer.');
    this.destinationProvider =
      destinationProvider ?? createSavedRtmpDestinationProvider(encryptionKey);
  }

  private processKey(ownerId: string, accountId: string): string {
    return `${ownerId}\0${accountId}`;
  }

  private occupiedSlots(): number {
    const keys = new Set(this.openingRooms);
    for (const [key, state] of this.processes) {
      if (['starting', 'live', 'stopping'].includes(state.status)) keys.add(key);
    }
    return keys.size;
  }

  private requireCapacity(key: string): void {
    if (
      this.maxConcurrentStreams !== null &&
      !this.openingRooms.has(key) &&
      this.occupiedSlots() >= this.maxConcurrentStreams
    )
      throw new LiveError(429, `Live capacity reached (${this.maxConcurrentStreams} streams).`);
  }

  isActive(ownerId: string, accountId: string): boolean {
    const state = this.processes.get(this.processKey(ownerId, accountId));
    return !!state && ['starting', 'live', 'stopping'].includes(state.status);
  }

  beginAccountDeletion(ownerId: string, accountId: string): (() => void) | null {
    const key = this.processKey(ownerId, accountId);
    if (
      this.isActive(ownerId, accountId) ||
      this.deletingAccounts.has(key) ||
      this.configuringAccounts.has(key)
    )
      return null;
    this.deletingAccounts.add(key);
    return () => this.deletingAccounts.delete(key);
  }

  async listVideos(ownerId: string): Promise<LiveVideo[]> {
    return this.store.listVideos(ownerId);
  }

  async deleteVideo(ownerId: string, videoId: string): Promise<void> {
    if (!isUuid(videoId)) throw new LiveError(400, 'Invalid video ID.');
    const result = await this.store.deleteVideo(ownerId, videoId);
    if (result === 'missing') throw new LiveError(404, 'Video not found.');
    if (result === 'in_use')
      throw new LiveError(409, 'Remove this video from live settings first.');
    await fs.rm(mediaPath(this.mediaDir, videoId), { force: true });
  }

  async uploadVideo(ownerId: string, name: string, input: Readable): Promise<LiveVideo> {
    if (!validVideoName(name)) throw new LiveError(400, 'Select an MP4 file with a valid name.');
    const usage = await this.store.videoUsage(ownerId);
    if (usage.count >= MAX_OWNER_VIDEOS || usage.bytes >= MAX_OWNER_VIDEO_BYTES) {
      throw new LiveError(413, 'Video storage limit reached.');
    }
    await fs.mkdir(this.mediaDir, { recursive: true });
    const id = randomUUID();
    const finalPath = mediaPath(this.mediaDir, id);
    const temporaryPath = `${finalPath}.upload`;
    const convertedPath = `${finalPath}.converted.mp4`;
    let size = 0;
    try {
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_VIDEO_BYTES || usage.bytes + size > MAX_OWNER_VIDEO_BYTES) {
            callback(new LiveError(413, 'Video storage limit reached.'));
          } else {
            callback(null, chunk);
          }
        },
      });
      await pipeline(input, limiter, createWriteStream(temporaryPath, { flags: 'wx' }));
      if (size < 12) throw new LiveError(400, 'Invalid MP4 file.');
      const fd = await fs.open(temporaryPath, 'r');
      let signature: Buffer;
      try {
        signature = Buffer.alloc(12);
        await fd.read(signature, 0, signature.length, 0);
      } finally {
        await fd.close();
      }
      if (signature.toString('ascii', 4, 8) !== 'ftyp') {
        throw new LiveError(400, 'Invalid MP4 file.');
      }
      const tracks = await this.probeVideo(temporaryPath);
      if (!tracks) throw new LiveError(422, 'MP4 must contain readable video and audio tracks.');
      const canCopy =
        typeof tracks === 'boolean' ||
        (tracks.videoCodec === 'h264' && tracks.audioCodec === 'aac');
      let storedSize = size;
      if (!canCopy) {
        try {
          await this.convertVideo(temporaryPath, convertedPath);
        } catch {
          throw new LiveError(422, 'Could not convert MP4 to H.264/AAC.');
        }
        const converted = await fs.stat(convertedPath).catch(() => null);
        if (
          !converted?.isFile() ||
          converted.size < 12 ||
          converted.size > MAX_VIDEO_BYTES ||
          usage.bytes + converted.size > MAX_OWNER_VIDEO_BYTES
        ) {
          throw new LiveError(413, 'Converted video exceeds the storage limit.');
        }
        const outputTracks = await this.probeVideo(convertedPath);
        if (
          typeof outputTracks !== 'object' ||
          outputTracks.videoCodec !== 'h264' ||
          outputTracks.audioCodec !== 'aac'
        ) {
          throw new LiveError(422, 'Converted video is not a valid H.264/AAC MP4.');
        }
        storedSize = converted.size;
      }
      await fs.rename(canCopy ? temporaryPath : convertedPath, finalPath);
      if (!canCopy) await fs.rm(temporaryPath, { force: true });
      const item = { id, name, sizeBytes: storedSize, createdAt: new Date().toISOString() };
      await this.store.insertVideo(ownerId, item);
      return item;
    } catch (error) {
      await Promise.allSettled([
        fs.rm(temporaryPath, { force: true }),
        fs.rm(convertedPath, { force: true }),
        fs.rm(finalPath, { force: true }),
      ]);
      throw error;
    }
  }

  async listSessions(ownerId: string): Promise<LiveSession[]> {
    const [accounts, configuredIds] = await Promise.all([
      this.accounts.list(ownerId),
      this.store.listConfiguredAccountIds(ownerId),
    ]);
    const configured = new Set(configuredIds);
    return Promise.all(
      accounts.map(async (account) => {
        const state = this.processes.get(this.processKey(ownerId, account.id));
        const config = configured.has(account.id)
          ? await this.store.getConfig(ownerId, account.id)
          : null;
        const selectedVideoId = await this.store.getPreferredVideoId(ownerId, account.id);
        const video =
          selectedVideoId || config
            ? await this.store.findVideo(ownerId, selectedVideoId ?? config!.videoId)
            : null;
        return {
          accountId: account.id,
          status: state?.status ?? 'idle',
          hasRtmpConfig: configured.has(account.id),
          hasOpenRoom: !!config?.roomId,
          ...(video ? { videoId: video.id, videoName: video.name } : {}),
          ...(state?.startedAt ? { startedAt: state.startedAt } : {}),
          ...(state?.error ? { error: state.error } : {}),
        };
      }),
    );
  }

  async session(ownerId: string, accountId: string): Promise<LiveSession> {
    const exists = await this.store.accountStatus(ownerId, accountId);
    if (!exists) throw new LiveError(404, 'Account not found.');
    const state = this.processes.get(this.processKey(ownerId, accountId));
    const config = await this.store.getConfig(ownerId, accountId);
    const selectedVideoId = await this.store.getPreferredVideoId(ownerId, accountId);
    const video =
      selectedVideoId || config
        ? await this.store.findVideo(ownerId, selectedVideoId ?? config!.videoId)
        : null;
    return {
      accountId,
      status: state?.status ?? 'idle',
      hasRtmpConfig: !!config,
      hasOpenRoom: !!config?.roomId,
      ...(video ? { videoId: video.id, videoName: video.name } : {}),
      ...(state?.startedAt ? { startedAt: state.startedAt } : {}),
      ...(state?.error ? { error: state.error } : {}),
    };
  }

  async currentRoomId(ownerId: string, accountId: string): Promise<string | null> {
    if (!(await this.store.accountStatus(ownerId, accountId))) {
      throw new LiveError(404, 'Account not found.');
    }
    return (await this.store.getConfig(ownerId, accountId))?.roomId ?? null;
  }

  async currentRoomState(ownerId: string, accountId: string): Promise<'open' | 'closed'> {
    const config = await this.store.getConfig(ownerId, accountId);
    if (!config?.roomId) return 'closed';
    if (!this.autoRoomChecker) throw new LiveError(503, 'Room check is unavailable.');
    const secret = await this.accounts.findEncrypted(ownerId, accountId);
    if (!secret) throw new LiveError(404, 'Account credentials not found.');
    return this.autoRoomChecker({
      cookieHeader: decryptAccountCookie(secret, this.encryptionKey, ownerId, accountId),
      userAgent: secret.userAgent
        ? decryptAccountUserAgent(secret.userAgent, this.encryptionKey, ownerId, accountId)
        : undefined,
      roomId: config.roomId,
      streamId: config.streamId,
    });
  }

  async clearClosedRoom(ownerId: string, accountId: string): Promise<void> {
    const config = await this.store.getConfig(ownerId, accountId);
    if (!config?.roomId) return;
    if ((await this.currentRoomState(ownerId, accountId)) !== 'closed')
      throw new LiveError(409, 'The existing LIVE room is still open.');
    await this.store.saveConfig(ownerId, accountId, {
      ...config,
      roomId: null,
      streamId: null,
    });
  }

  async configure(
    ownerId: string,
    accountId: string,
    input: { rtmpUrl: unknown; streamKey: unknown; videoId: unknown },
  ): Promise<LiveSession> {
    const key = this.processKey(ownerId, accountId);
    if (
      this.isActive(ownerId, accountId) ||
      this.deletingAccounts.has(key) ||
      this.configuringAccounts.has(key)
    ) {
      throw new LiveError(409, 'Stop the live stream first.');
    }
    if (
      !validRtmpUrl(input.rtmpUrl) ||
      !validStreamKey(input.streamKey) ||
      typeof input.videoId !== 'string' ||
      !isUuid(input.videoId)
    ) {
      throw new LiveError(400, 'Invalid live configuration.');
    }
    this.configuringAccounts.add(key);
    try {
      const status = await this.store.accountStatus(ownerId, accountId);
      if (!status) throw new LiveError(404, 'Account not found.');
      if (status !== 'connected')
        throw new LiveError(422, 'Connect the account before configuring live.');
      const video = await this.store.findVideo(ownerId, input.videoId);
      if (!video) throw new LiveError(404, 'Video not found.');
      await this.store.saveConfig(ownerId, accountId, {
        videoId: input.videoId,
        rtmpUrl: encrypted(input.rtmpUrl, this.encryptionKey, `${ownerId}\0${accountId}\0rtmp-url`),
        streamKey: encrypted(
          input.streamKey,
          this.encryptionKey,
          `${ownerId}\0${accountId}\0stream-key`,
        ),
      });
      return this.session(ownerId, accountId);
    } finally {
      this.configuringAccounts.delete(key);
    }
  }

  async autoFetchDestination(
    ownerId: string,
    accountId: string,
    videoId: unknown,
    title: unknown,
  ): Promise<{ session: LiveSession; roomId: string }> {
    if (!this.autoRoomCreator)
      throw new LiveError(503, 'Automatic LIVE room creation is not configured.');
    if (
      typeof videoId !== 'string' ||
      !isUuid(videoId) ||
      typeof title !== 'string' ||
      !title.trim() ||
      title.trim().length > 120 ||
      /[\r\n]/.test(title)
    ) {
      throw new LiveError(400, 'Select a video and enter a LIVE title.');
    }
    const key = this.processKey(ownerId, accountId);
    if (
      this.isActive(ownerId, accountId) ||
      this.deletingAccounts.has(key) ||
      this.configuringAccounts.has(key)
    ) {
      throw new LiveError(409, 'Stop the current stream before creating a new room.');
    }
    this.configuringAccounts.add(key);
    try {
      const status = await this.store.accountStatus(ownerId, accountId);
      if (!status) throw new LiveError(404, 'Account not found.');
      if (status !== 'connected') throw new LiveError(422, 'Account is not connected.');
      const video = await this.store.findVideo(ownerId, videoId);
      if (!video) throw new LiveError(404, 'Video not found.');
      const path = mediaPath(this.mediaDir, videoId);
      const file = await fs.stat(path).catch(() => null);
      if (!file?.isFile() || file.size !== video.sizeBytes || !(await this.probeVideo(path))) {
        throw new LiveError(
          422,
          'Select an MP4 with readable video and audio before creating a room.',
        );
      }
      await this.store.savePreferredVideoId(ownerId, accountId, videoId);
      const secret = await this.accounts.findEncrypted(ownerId, accountId);
      if (!secret) throw new LiveError(404, 'Account credentials not found.');
      const cookieHeader = decryptAccountCookie(secret, this.encryptionKey, ownerId, accountId);
      const userAgent = secret.userAgent
        ? decryptAccountUserAgent(secret.userAgent, this.encryptionKey, ownerId, accountId)
        : undefined;
      let room: Awaited<ReturnType<AutoRoomCreator>>;
      try {
        room = await this.autoRoomCreator({ title: title.trim(), cookieHeader, userAgent });
      } catch (error) {
        console.error(
          '[live] room creation failed:',
          error instanceof Error ? error.message : 'unknown error',
        );
        throw new LiveError(
          502,
          'TikTok did not create a LIVE room. Check the session and signer setup.',
        );
      }
      if (
        !validRtmpUrl(room.rtmpUrl) ||
        !validStreamKey(room.streamKey) ||
        !/^\d{8,24}$/.test(room.roomId) ||
        !/^\d{8,24}$/.test(room.streamId)
      ) {
        throw new LiveError(502, 'TikTok returned an invalid LIVE destination.');
      }
      try {
        await this.store.saveConfig(ownerId, accountId, {
          videoId,
          rtmpUrl: encrypted(
            room.rtmpUrl,
            this.encryptionKey,
            `${ownerId}\0${accountId}\0rtmp-url`,
          ),
          streamKey: encrypted(
            room.streamKey,
            this.encryptionKey,
            `${ownerId}\0${accountId}\0stream-key`,
          ),
          roomId: room.roomId,
          streamId: room.streamId,
        });
      } catch {
        if (this.autoRoomEnder) {
          await this.autoRoomEnder({
            cookieHeader,
            userAgent,
            roomId: room.roomId,
            streamId: room.streamId,
          }).catch(() => 'unverified');
        }
        throw new LiveError(
          503,
          'The LIVE room was created but its settings could not be saved. Check TikTok before retrying.',
        );
      }
      return { session: await this.session(ownerId, accountId), roomId: room.roomId };
    } finally {
      this.configuringAccounts.delete(key);
    }
  }

  async selectVideo(ownerId: string, accountId: string, videoId: unknown): Promise<LiveSession> {
    const key = this.processKey(ownerId, accountId);
    if (
      this.isActive(ownerId, accountId) ||
      this.deletingAccounts.has(key) ||
      this.configuringAccounts.has(key)
    ) {
      throw new LiveError(409, 'Stop the live stream first.');
    }
    if (typeof videoId !== 'string' || !isUuid(videoId)) {
      throw new LiveError(400, 'Invalid video ID.');
    }
    this.configuringAccounts.add(key);
    try {
      const status = await this.store.accountStatus(ownerId, accountId);
      if (!status) throw new LiveError(404, 'Account not found.');
      if (status !== 'connected') throw new LiveError(422, 'Account is not connected.');
      const video = await this.store.findVideo(ownerId, videoId);
      if (!video) throw new LiveError(404, 'Video not found.');
      const config = await this.store.getConfig(ownerId, accountId);
      if (config) await this.store.saveConfig(ownerId, accountId, { ...config, videoId });
      await this.store.savePreferredVideoId(ownerId, accountId, videoId);
      return this.session(ownerId, accountId);
    } finally {
      this.configuringAccounts.delete(key);
    }
  }

  async startAuto(
    ownerId: string,
    accountId: string,
    title: unknown,
  ): Promise<{ session: LiveSession; roomId: string }> {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) {
      throw new LiveError(400, 'Enter a LIVE title before starting.');
    }
    const key = this.processKey(ownerId, accountId);
    if (this.isActive(ownerId, accountId)) throw new LiveError(409, 'Live is already running.');
    if (this.openingRooms.has(key)) throw new LiveError(409, 'LIVE room is already opening.');
    this.requireCapacity(key);
    this.openingRooms.add(key);
    try {
      const selectedVideoId = await this.store.getPreferredVideoId(ownerId, accountId);
      const config = await this.store.getConfig(ownerId, accountId);
      const videoId = selectedVideoId ?? config?.videoId;
      if (!videoId) throw new LiveError(422, 'Select a video before starting.');
      const { roomId } = await this.autoFetchDestination(ownerId, accountId, videoId, title);
      try {
        return { session: await this.start(ownerId, accountId, true), roomId };
      } catch (error) {
        // A room may have been created even when the encoder cannot start.
        await this.finishRoom(ownerId, accountId).catch(() => 'unverified');
        throw error;
      }
    } finally {
      this.openingRooms.delete(key);
    }
  }

  async finishRoom(
    ownerId: string,
    accountId: string,
  ): Promise<'ended' | 'no_room' | 'unavailable' | 'unverified'> {
    if (!this.autoRoomEnder) return 'unavailable';
    const status = await this.store.accountStatus(ownerId, accountId);
    if (!status) throw new LiveError(404, 'Account not found.');
    const secret = await this.accounts.findEncrypted(ownerId, accountId);
    if (!secret) return 'unavailable';
    const cookieHeader = decryptAccountCookie(secret, this.encryptionKey, ownerId, accountId);
    const userAgent = secret.userAgent
      ? decryptAccountUserAgent(secret.userAgent, this.encryptionKey, ownerId, accountId)
      : undefined;
    const config = await this.store.getConfig(ownerId, accountId);
    try {
      const result = await this.autoRoomEnder({
        cookieHeader,
        userAgent,
        roomId: config?.roomId,
        streamId: config?.streamId,
      });
      if (config && (result === 'ended' || result === 'no_room')) {
        await this.store.saveConfig(ownerId, accountId, {
          ...config,
          roomId: null,
          streamId: null,
        });
      }
      return result;
    } catch {
      return 'unverified';
    }
  }

  async stopAndEnd(
    ownerId: string,
    accountId: string,
  ): Promise<{
    session: LiveSession;
    roomEnd: 'ended' | 'no_room' | 'unavailable' | 'unverified';
  }> {
    await this.stop(ownerId, accountId);
    const state = this.processes.get(this.processKey(ownerId, accountId));
    if (state?.child && state.status === 'stopping' && state.child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_500);
        timer.unref();
        state.child!.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const roomEnd = await this.finishRoom(ownerId, accountId);
    return { session: await this.session(ownerId, accountId), roomEnd };
  }

  async start(ownerId: string, accountId: string, roomReserved = false): Promise<LiveSession> {
    const key = this.processKey(ownerId, accountId);
    if (this.deletingAccounts.has(key)) throw new LiveError(409, 'Account is being deleted.');
    if (this.configuringAccounts.has(key)) throw new LiveError(409, 'Live settings are changing.');
    if (this.isActive(ownerId, accountId)) throw new LiveError(409, 'Live is already running.');
    if (this.openingRooms.has(key) && !roomReserved)
      throw new LiveError(409, 'LIVE room is already opening.');
    this.requireCapacity(key);
    const state: RunningProcess = { status: 'starting', cancelled: false };
    this.processes.set(key, state);
    try {
      const status = await this.store.accountStatus(ownerId, accountId);
      if (!status) throw new LiveError(404, 'Account not found.');
      if (status !== 'connected') throw new LiveError(422, 'Account is not connected.');
      const config = await this.store.getConfig(ownerId, accountId);
      if (!config) throw new LiveError(422, 'Save RTMP settings and select a video first.');
      const video = await this.store.findVideo(ownerId, config.videoId);
      if (!video) throw new LiveError(404, 'Video not found.');
      const path = mediaPath(this.mediaDir, video.id);
      const file = await fs.stat(path).catch(() => null);
      if (!file?.isFile() || file.size !== video.sizeBytes) {
        throw new LiveError(422, 'Video file is unavailable.');
      }
      const tracks = await this.probeVideo(path);
      if (!tracks) {
        throw new LiveError(422, 'MP4 must contain readable video and audio tracks.');
      }
      const canCopy =
        typeof tracks === 'object' && tracks.videoCodec === 'h264' && tracks.audioCodec === 'aac';
      if (state.cancelled) return this.session(ownerId, accountId);
      const destination = await this.destinationProvider.resolve({ ownerId, accountId, config });
      const child = this.spawnProcess(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-stream_loop',
          '-1',
          '-re',
          '-i',
          path,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-c:v',
          ...(canCopy ? ['copy'] : ['libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']),
          '-c:a',
          canCopy ? 'copy' : 'aac',
          '-f',
          'flv',
          '-progress',
          'pipe:3',
          destination.url,
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
      );
      state.child = child;
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8192);
      });
      state.startupTimer = setTimeout(() => {
        if (state.status === 'starting') {
          state.error = 'Streaming connection timed out.';
          child.kill('SIGKILL');
        }
      }, 30_000);
      state.startupTimer.unref();
      let progressBuffer = '';
      const progress = child.stdio[3];
      if (progress && 'on' in progress) {
        progress.on('data', (chunk: Buffer) => {
          if (state.status !== 'starting') return;
          progressBuffer = (progressBuffer + chunk.toString('utf8')).slice(-8192);
          if (/progress=continue(?:\r?\n|$)/.test(progressBuffer) && child.exitCode === null) {
            state.status = 'live';
            state.startedAt = new Date().toISOString();
            if (state.startupTimer) clearTimeout(state.startupTimer);
            progressBuffer = '';
          }
        });
      }
      child.once('error', () => {
        if (state.stopTimer) clearTimeout(state.stopTimer);
        if (state.startupTimer) clearTimeout(state.startupTimer);
        state.status = state.cancelled ? 'idle' : 'failed';
        state.error = state.cancelled
          ? undefined
          : (state.error ?? 'Streaming process could not start.');
      });
      child.once('exit', () => {
        if (state.stopTimer) clearTimeout(state.stopTimer);
        if (state.startupTimer) clearTimeout(state.startupTimer);
        state.status = state.cancelled ? 'idle' : 'failed';
        state.error = state.cancelled ? undefined : (state.error ?? streamFailure(stderr));
        state.child = undefined;
      });
      if (state.cancelled) child.kill('SIGTERM');
      return this.session(ownerId, accountId);
    } catch (error) {
      if (state.child) {
        state.cancelled = true;
        if (state.startupTimer) clearTimeout(state.startupTimer);
        state.child.kill('SIGTERM');
      }
      state.status = 'failed';
      state.error = error instanceof LiveError ? error.message : 'Live could not start.';
      throw error;
    }
  }

  async stop(ownerId: string, accountId: string): Promise<LiveSession> {
    const key = this.processKey(ownerId, accountId);
    const state = this.processes.get(key);
    if (!state || !this.isActive(ownerId, accountId)) {
      return this.session(ownerId, accountId);
    }
    state.cancelled = true;
    if (state.startupTimer) clearTimeout(state.startupTimer);
    if (state.child) {
      state.status = 'stopping';
      state.child.kill('SIGTERM');
      state.stopTimer = setTimeout(() => state.child?.kill('SIGKILL'), 5000);
      state.stopTimer.unref();
    } else {
      state.status = 'idle';
    }
    return this.session(ownerId, accountId);
  }

  async stopAll(): Promise<void> {
    for (const state of this.processes.values()) {
      state.cancelled = true;
      if (state.stopTimer) clearTimeout(state.stopTimer);
      if (state.startupTimer) clearTimeout(state.startupTimer);
      state.child?.kill('SIGTERM');
      state.status = 'idle';
    }
  }
}
