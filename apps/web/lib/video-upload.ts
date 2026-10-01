import { apiPath } from './base-path';
export const maxVideoBytes = 8 * 1024 * 1024 * 1024;
export const maxLibraryBytes = 40 * 1024 * 1024 * 1024;
export const maxLibraryVideos = 100;

export type StoredVideo = {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  status?: 'ready' | 'converting' | 'failed';
  error?: string;
};

type UploadInfo = {
  uploadId: string;
  size: number;
  chunkSize: number;
  total: number;
  received: number[];
  state?: 'uploading' | 'processing' | 'failed' | 'done';
  error?: string;
  item?: StoredVideo;
};

type Reply = { status: number; body: unknown };

const parallelChunks = 4;
const maxAttempts = 6;

class RestartUpload extends Error {}

function send(
  method: string,
  url: string,
  body?: XMLHttpRequestBodyInit,
  headers: Record<string, string> = {},
  onProgress?: (loaded: number) => void,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, apiPath(url));
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    if (onProgress) request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onerror = () => reject(new Error('เชื่อมต่อระบบอัปโหลดไม่ได้ กรุณาลองอีกครั้ง'));
    request.onload = () => {
      let parsed: unknown;
      try {
        parsed = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        parsed = null;
      }
      resolve({ status: request.status, body: parsed });
    };
    request.send(body ?? null);
  });
}

function isInfo(value: unknown): value is UploadInfo {
  return (
    !!value &&
    typeof value === 'object' &&
    'uploadId' in value &&
    typeof value.uploadId === 'string' &&
    'chunkSize' in value &&
    typeof value.chunkSize === 'number' &&
    'total' in value &&
    typeof value.total === 'number' &&
    'received' in value &&
    Array.isArray(value.received)
  );
}

function resumeKey(file: File): string {
  return `livehub-upload:${file.name}:${file.size}:${file.lastModified}`;
}

function remember(file: File, uploadId: string | null) {
  try {
    if (uploadId) localStorage.setItem(resumeKey(file), uploadId);
    else localStorage.removeItem(resumeKey(file));
  } catch {
    // Resume is a convenience; uploads still work without storage.
  }
}

function savedUploadId(file: File): string | null {
  try {
    return localStorage.getItem(resumeKey(file));
  } catch {
    return null;
  }
}

async function openUpload(file: File): Promise<UploadInfo> {
  const saved = savedUploadId(file);
  if (saved) {
    const status = await send('GET', `/api/live/uploads/${encodeURIComponent(saved)}`);
    if (
      status.status === 200 &&
      isInfo(status.body) &&
      status.body.size === file.size &&
      status.body.state !== 'failed' &&
      status.body.state !== 'done'
    ) {
      return status.body;
    }
    remember(file, null);
  }
  const created = await send(
    'POST',
    '/api/live/uploads',
    JSON.stringify({ name: file.name, size: file.size }),
    { 'Content-Type': 'application/json' },
  );
  if (created.status === 413) throw new Error('ไฟล์ใหญ่เกิน 8 GB หรือพื้นที่คลัง 40 GB เต็ม');
  if (created.status === 429) {
    throw new Error('มีไฟล์ที่อัปโหลดค้างอยู่หลายไฟล์ กรุณารอสักครู่แล้วลองอีกครั้ง');
  }
  if (created.status === 401) throw new Error('หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่');
  if (created.status !== 201 || !isInfo(created.body)) {
    throw new Error('เริ่มอัปโหลดวิดีโอไม่สำเร็จ กรุณาลองอีกครั้ง');
  }
  remember(file, created.body.uploadId);
  return created.body;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendChunk(
  file: File,
  info: UploadInfo,
  index: number,
  onProgress: (loaded: number) => void,
): Promise<void> {
  const start = index * info.chunkSize;
  const blob = file.slice(start, Math.min(file.size, start + info.chunkSize));
  for (let attempt = 1; ; attempt++) {
    try {
      const reply = await send(
        'PUT',
        `/api/live/uploads/${encodeURIComponent(info.uploadId)}/chunks/${index}`,
        blob,
        { 'Content-Type': 'application/octet-stream' },
        onProgress,
      );
      if (reply.status === 200) return;
      if (reply.status === 404) throw new RestartUpload();
      if (reply.status === 401) throw new Error('หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่');
      if (reply.status < 500 && reply.status !== 408 && reply.status !== 429) {
        throw new Error('อัปโหลดวิดีโอไม่สำเร็จ กรุณาลองอีกครั้ง');
      }
    } catch (error) {
      if (error instanceof RestartUpload || attempt >= maxAttempts) throw error;
      if (error instanceof Error && !error.message.startsWith('เชื่อมต่อ')) throw error;
    }
    if (attempt >= maxAttempts) throw new Error('อัปโหลดวิดีโอไม่สำเร็จ กรุณาลองอีกครั้ง');
    onProgress(0);
    await wait(Math.min(15_000, 1000 * 2 ** (attempt - 1)));
  }
}

function failureMessage(error: string | undefined): string {
  if (error?.includes('convert')) {
    return 'ไฟล์ MP4 นี้แปลงเป็น H.264/AAC ไม่สำเร็จ กรุณาตรวจสอบไฟล์ต้นฉบับ';
  }
  if (error?.includes('limit') || error?.includes('exceeds')) {
    return 'ไฟล์ใหญ่เกิน 8 GB หรือพื้นที่คลัง 40 GB เต็ม';
  }
  return 'ตรวจหรือแปลงวิดีโอไม่สำเร็จ กรุณาลองอีกครั้ง';
}

async function waitForProcessing(file: File, uploadId: string): Promise<StoredVideo> {
  let misses = 0;
  for (;;) {
    await wait(4000);
    let reply: Reply;
    try {
      reply = await send('GET', `/api/live/uploads/${encodeURIComponent(uploadId)}`);
    } catch {
      if (++misses > 30) throw new Error('เชื่อมต่อระบบอัปโหลดไม่ได้ กรุณารีเฟรชคลังวิดีโอ');
      continue;
    }
    if (reply.status === 404) {
      remember(file, null);
      throw new Error('ระบบรีสตาร์ตระหว่างแปลงไฟล์ กรุณาอัปโหลดใหม่อีกครั้ง');
    }
    if (reply.status !== 200 || !isInfo(reply.body)) {
      if (++misses > 30) throw new Error('เชื่อมต่อระบบอัปโหลดไม่ได้ กรุณารีเฟรชคลังวิดีโอ');
      continue;
    }
    misses = 0;
    if (reply.body.state === 'done' && reply.body.item) {
      remember(file, null);
      return reply.body.item;
    }
    if (reply.body.state === 'failed') {
      remember(file, null);
      throw new Error(failureMessage(reply.body.error));
    }
  }
}
async function transfer(file: File, onProgress: (percent: number) => void): Promise<StoredVideo> {
  const info = await openUpload(file);
  if (info.state === 'processing') {
    onProgress(100);
    return waitForProcessing(file, info.uploadId);
  }
  const confirmed = new Set(info.received);
  const inFlight = new Map<number, number>();
  const length = (index: number) => Math.min(info.chunkSize, file.size - index * info.chunkSize);
  const report = () => {
    let bytes = 0;
    for (const index of confirmed) bytes += length(index);
    for (const loaded of inFlight.values()) bytes += loaded;
    onProgress(Math.min(100, Math.floor((bytes / file.size) * 100)));
  };
  report();

  for (let round = 0; round < 3; round++) {
    const queue: number[] = [];
    for (let index = 0; index < info.total; index++) if (!confirmed.has(index)) queue.push(index);
    let failure: unknown = null;
    await Promise.all(
      Array.from({ length: parallelChunks }, async () => {
        while (!failure) {
          const index = queue.shift();
          if (index === undefined) return;
          try {
            await sendChunk(file, info, index, (loaded) => {
              inFlight.set(index, loaded);
              report();
            });
            inFlight.delete(index);
            confirmed.add(index);
            report();
          } catch (error) {
            inFlight.delete(index);
            failure = error;
          }
        }
      }),
    );
    if (failure) throw failure;

    onProgress(100);
    const done = await send(
      'POST',
      `/api/live/uploads/${encodeURIComponent(info.uploadId)}/complete`,
    );
    if (done.status === 202) return waitForProcessing(file, info.uploadId);
    if (done.status === 409) {
      const status = await send('GET', `/api/live/uploads/${encodeURIComponent(info.uploadId)}`);
      if (status.status === 200 && isInfo(status.body)) {
        confirmed.clear();
        for (const index of status.body.received) confirmed.add(index);
        continue;
      }
    }
    remember(file, null);
    if (done.status === 413) throw new Error('ไฟล์ใหญ่เกิน 8 GB หรือพื้นที่คลัง 40 GB เต็ม');
    if (done.status === 422) {
      throw new Error('ไฟล์ MP4 นี้แปลงเป็น H.264/AAC ไม่สำเร็จ กรุณาตรวจสอบไฟล์ต้นฉบับ');
    }
    throw new Error('อัปโหลดวิดีโอไม่สำเร็จ กรุณาลองอีกครั้ง');
  }
  throw new Error('อัปโหลดวิดีโอไม่ครบ กรุณาลองอีกครั้ง');
}

export async function uploadMp4(
  file: File,
  onProgress: (percent: number) => void,
): Promise<StoredVideo> {
  try {
    return await transfer(file, onProgress);
  } catch (error) {
    if (!(error instanceof RestartUpload)) throw error;
    remember(file, null);
    return transfer(file, onProgress);
  }
}
