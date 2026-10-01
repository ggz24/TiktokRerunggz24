import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const GCS = 'https://storage.googleapis.com';
const TRANSCODER = 'https://transcoder.googleapis.com/v1';

export type CloudTranscodeOptions = {
  bucket: string;
  location?: string;
  projectId?: string;
  http?: typeof fetch;
  uploadChunkBytes?: number;
  pollMs?: number;
  maxWaitMs?: number;
  probeFrameRate?: (path: string) => Promise<number>;
  newId?: () => string;
};

export type CloudTranscoder = (
  source: string,
  destination: string,
  signal?: AbortSignal,
) => Promise<void>;

async function defaultFrameRate(path: string): Promise<number> {
  return new Promise((resolveRate) => {
    const child = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=r_frame_rate',
        '-of',
        'csv=p=0',
        path,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], shell: false },
    );
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 200) output += chunk.toString('utf8');
    });
    child.once('error', () => resolveRate(30));
    child.once('close', () => {
      const [num, den] = output.trim().split('/').map(Number);
      const rate = den ? num / den : num;
      resolveRate(Number.isFinite(rate) && rate >= 1 && rate <= 60 ? Math.round(rate) : 30);
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        rejectSleep(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Converts a video with Google Cloud Transcoder; auth comes from the VM's service account. */
export function createCloudTranscoder(options: CloudTranscodeOptions): CloudTranscoder {
  const http = options.http ?? fetch;
  const location = options.location ?? 'asia-southeast1';
  const chunkBytes = options.uploadChunkBytes ?? 32 * 1024 * 1024;
  const pollMs = options.pollMs ?? 15_000;
  const maxWaitMs = options.maxWaitMs ?? 6 * 60 * 60 * 1000;
  const frameRateOf = options.probeFrameRate ?? defaultFrameRate;
  let token: { value: string; expiresAt: number } | null = null;
  let projectId = options.projectId ?? '';

  async function metadata(path: string): Promise<Response> {
    const response = await http(`${METADATA}${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Metadata server returned HTTP ${response.status}.`);
    return response;
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const body = (await (await metadata('/instance/service-accounts/default/token')).json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error('No access token from the metadata server.');
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return token.value;
  }

  async function authed(
    url: string,
    init: RequestInit = {},
    timeoutMs = 60_000,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await accessToken()}`);
    return http(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  async function putObject(object: string, path: string, size: number): Promise<void> {
    const start = await authed(
      `${GCS}/upload/storage/v1/b/${options.bucket}/o?uploadType=resumable&name=${encodeURIComponent(object)}`,
      { method: 'POST', headers: { 'X-Upload-Content-Type': 'video/mp4' } },
    );
    const session = start.headers.get('location');
    if (!start.ok || !session) throw new Error(`Could not start upload (HTTP ${start.status}).`);
    const file = await fs.open(path, 'r');
    try {
      let offset = 0;
      let failures = 0;
      while (offset < size) {
        const length = Math.min(chunkBytes, size - offset);
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, offset);
        const last = offset + length >= size;
        try {
          const response = await authed(
            session,
            {
              method: 'PUT',
              headers: {
                'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`,
              },
              body: buffer,
            },
            300_000,
          );
          if (response.status === 308) {
            const range = response.headers.get('range');
            offset = range ? Number(range.split('-')[1]) + 1 : offset;
          } else if (response.ok && last) {
            offset = size;
          } else {
            throw new Error(`Upload chunk failed (HTTP ${response.status}).`);
          }
          failures = 0;
        } catch (error) {
          if (++failures > 4) throw error;
          const probe = await authed(session, {
            method: 'PUT',
            headers: { 'Content-Range': `bytes */${size}` },
          }).catch(() => null);
          if (probe?.status === 308) {
            const range = probe.headers.get('range');
            offset = range ? Number(range.split('-')[1]) + 1 : 0;
          } else if (probe?.ok) {
            offset = size;
          }
          await sleep(1000 * failures);
        }
      }
    } finally {
      await file.close();
    }
  }

  async function deleteObject(object: string): Promise<void> {
    await authed(
      `${GCS}/storage/v1/b/${options.bucket}/o/${encodeURIComponent(object)}`,
      { method: 'DELETE' },
      30_000,
    ).catch(() => undefined);
  }

  async function download(object: string, destination: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await authed(
          `${GCS}/storage/v1/b/${options.bucket}/o/${encodeURIComponent(object)}?alt=media`,
          {},
          6 * 60 * 60 * 1000,
        );
        if (!response.ok || !response.body)
          throw new Error(`Download failed (HTTP ${response.status}).`);
        await pipeline(
          Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
          createWriteStream(destination),
        );
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        await sleep(2000 * attempt);
      }
    }
  }

  return async (source, destination, signal) => {
    const stat = await fs.stat(source);
    if (!projectId) projectId = (await (await metadata('/project/project-id')).text()).trim();
    const id = (
      options.newId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
    )();
    const inputObject = `in/${id}.mp4`;
    const outputPrefix = `out/${id}/`;
    const outputObject = `${outputPrefix}out.mp4`;
    try {
      await putObject(inputObject, source, stat.size);
      const frameRate = await frameRateOf(source);
      const created = await authed(
        `${TRANSCODER}/projects/${projectId}/locations/${location}/jobs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputUri: `gs://${options.bucket}/${inputObject}`,
            outputUri: `gs://${options.bucket}/${outputPrefix}`,
            config: {
              elementaryStreams: [
                {
                  key: 'video-stream0',
                  videoStream: {
                    h264: {
                      frameRate,
                      bitrateBps: 4_000_000,
                      crfLevel: 23,
                      pixelFormat: 'yuv420p',
                      profile: 'high',
                    },
                  },
                },
                { key: 'audio-stream0', audioStream: { codec: 'aac', bitrateBps: 128_000 } },
              ],
              muxStreams: [
                {
                  key: 'mp4-out',
                  fileName: 'out.mp4',
                  container: 'mp4',
                  elementaryStreams: ['video-stream0', 'audio-stream0'],
                },
              ],
            },
          }),
        },
      );
      const job = (await created.json().catch(() => null)) as { name?: string } | null;
      if (!created.ok || !job?.name) {
        throw new Error(`Could not create the transcoder job (HTTP ${created.status}).`);
      }
      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        await sleep(pollMs, signal);
        if (Date.now() > deadline) throw new Error('Transcoder job timed out.');
        const status = await authed(`${TRANSCODER}/${job.name}`);
        if (!status.ok) continue;
        const state = ((await status.json()) as { state?: string }).state;
        if (state === 'SUCCEEDED') break;
        if (state === 'FAILED') throw new Error('Transcoder job failed.');
      }
      await download(outputObject, destination);
    } finally {
      await Promise.allSettled([deleteObject(inputObject), deleteObject(outputObject)]);
    }
  };
}
