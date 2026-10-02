import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { isSameOrigin } from '@/lib/origin';

export const noStore = { 'Cache-Control': 'no-store' };
export const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function liveError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

export async function liveAuthorization(request: Request, mutation: boolean) {
  const username = await currentUser();
  if (!username) return { response: liveError('กรุณาเข้าสู่ระบบ', 401) };
  if (mutation && !isSameOrigin(request)) {
    return { response: liveError('คำขอไม่ถูกต้อง', 403) };
  }
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return { response: liveError('ระบบสตรีมยังไม่พร้อม', 503) };
  return {
    headers: { 'x-internal-token': token, 'x-livehub-owner': username },
  };
}

function upstreamError(status: number) {
  if (status === 400 || status === 415 || status === 422) {
    return liveError('ข้อมูลสตรีมไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง', status);
  }
  if (status === 404) return liveError('ไม่พบบัญชีหรือวิดีโอที่เลือก', 404);
  if (status === 409) return liveError('สถานะสตรีมไม่พร้อมสำหรับคำสั่งนี้', 409);
  if (status === 413) return liveError('ไฟล์ใหญ่เกิน 8 GB หรือพื้นที่คลังเต็ม', 413);
  return liveError('ระบบสตรีมยังไม่พร้อม กรุณาลองอีกครั้ง', 503);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeVideo(value: unknown) {
  const item = asRecord(value);
  return {
    id: typeof item.id === 'string' ? item.id : '',
    name: typeof item.name === 'string' ? item.name : '',
    sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : 0,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    status: item.status === 'converting' || item.status === 'failed' ? item.status : 'ready',
    ...(item.status === 'failed' && typeof item.error === 'string'
      ? { error: item.error.slice(0, 200) }
      : {}),
  };
}

function safeSession(value: unknown) {
  const item = asRecord(value);
  const status = item.status;
  return {
    accountId: typeof item.accountId === 'string' ? item.accountId : '',
    status:
      status === 'idle' ||
      status === 'starting' ||
      status === 'live' ||
      status === 'stopping' ||
      status === 'failed'
        ? status
        : 'failed',
    videoId: typeof item.videoId === 'string' ? item.videoId : null,
    videoName: typeof item.videoName === 'string' ? item.videoName : null,
    hasRtmpConfig: item.hasRtmpConfig === true,
    hasOpenRoom: item.hasOpenRoom === true,
    startedAt: typeof item.startedAt === 'string' ? item.startedAt : null,
  };
}

function safeResult(path: string, result: unknown) {
  const data = asRecord(result);
  if (path.endsWith('/auto-settings') && data.item) {
    const item = asRecord(data.item);
    const settings = asRecord(item.settings);
    return {
      item: {
        settings: {
          endAfterMinutes:
            typeof settings.endAfterMinutes === 'number' ? settings.endAfterMinutes : null,
          restartAfterMinutes:
            typeof settings.restartAfterMinutes === 'number' ? settings.restartAfterMinutes : null,
          dailyStartTime:
            typeof settings.dailyStartTime === 'string' ? settings.dailyStartTime : null,
          recoverStream: settings.recoverStream === true,
          closedRoomAction: settings.closedRoomAction === 'new_room' ? 'new_room' : 'stop',
        },
        phase: ['idle', 'live', 'resting'].includes(String(item.phase)) ? item.phase : 'idle',
        phaseStartedAt: typeof item.phaseStartedAt === 'string' ? item.phaseStartedAt : null,
        lastError: typeof item.lastError === 'string' ? item.lastError : null,
      },
    };
  }
  if (path.includes('/live/uploads')) {
    const state = ['uploading', 'processing', 'failed', 'done'].includes(String(data.state))
      ? (data.state as string)
      : undefined;
    if (typeof data.uploadId === 'string' && Array.isArray(data.received)) {
      return {
        uploadId: data.uploadId,
        size: typeof data.size === 'number' ? data.size : 0,
        chunkSize: typeof data.chunkSize === 'number' ? data.chunkSize : 0,
        total: typeof data.total === 'number' ? data.total : 0,
        received: data.received.filter((value): value is number => Number.isInteger(value)),
        ...(state ? { state } : {}),
        ...(typeof data.error === 'string' ? { error: data.error.slice(0, 200) } : {}),
        ...(data.item ? { item: safeVideo(data.item) } : {}),
      };
    }
    if (data.ok === true) return { ok: true };
    if (data.item) return { item: safeVideo(data.item) };
  }
  if (path.includes('/live/videos')) {
    if (Array.isArray(data.items)) return { items: data.items.map(safeVideo) };
    if (data.item) return { item: safeVideo(data.item) };
  }
  if (path.includes('/live/sessions')) {
    if (Array.isArray(data.items)) return { items: data.items.map(safeSession) };
    if (data.item) {
      const item = safeSession(data.item);
      if (
        (path.endsWith('/auto-destination') || path.endsWith('/start-auto')) &&
        typeof data.roomId === 'string' &&
        /^\d{8,24}$/.test(data.roomId)
      ) {
        return {
          item,
          roomId: data.roomId,
          ...(path.endsWith('/start-auto') &&
          ['accepted', 'rejected', 'unverified', 'none'].includes(String(data.productsOutcome))
            ? { productsOutcome: data.productsOutcome }
            : {}),
        };
      }
      if (
        path.endsWith('/stop') &&
        ['ended', 'no_room', 'unavailable', 'unverified'].includes(String(data.roomEnd))
      ) {
        return { item, roomEnd: data.roomEnd };
      }
      return { item };
    }
  }
  return null;
}

export async function proxyLive(
  request: Request,
  path: string,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  options?: { contentType?: string; body?: BodyInit; fileName?: string; timeoutMs?: number },
) {
  const authorization = await liveAuthorization(request, method !== 'GET');
  if ('response' in authorization) return authorization.response;
  const headers: Record<string, string> = { ...authorization.headers };
  if (options?.contentType) headers['Content-Type'] = options.contentType;
  if (options?.fileName) headers['x-file-name'] = options.fileName;
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const response = await fetch(new URL(path, base), {
      method,
      headers,
      body: options?.body,
      cache: 'no-store',
      signal: AbortSignal.timeout(options?.timeoutMs ?? 15000),
      ...(options?.body && typeof options.body !== 'string' && 'getReader' in options.body
        ? { duplex: 'half' as const }
        : {}),
    } as RequestInit & { duplex?: 'half' });
    if (!response.ok) {
      if (path.endsWith('/start-auto') || path.endsWith('/auto-destination')) {
        const data = asRecord(await response.json().catch(() => null));
        const code =
          typeof data.error === 'string'
            ? /^TikTok rejected LIVE creation \(code: (\d{1,10})\)\.$/.exec(data.error)?.[1]
            : undefined;
        if (code)
          return liveError(
            `TikTok ปฏิเสธการสร้างห้อง LIVE (รหัส ${code}) กรุณาตรวจสิทธิ์ LIVE และ session ของบัญชี`,
            502,
          );
        if (data.error === 'TikTok did not create a LIVE room. Check the session and signer setup.')
          return liveError(
            'TikTok ไม่ยอมสร้างห้อง LIVE กรุณาตรวจสิทธิ์ LIVE, session และบริการดึงคีย์',
            502,
          );
      }
      return upstreamError(response.status);
    }
    if (response.status === 204) return new Response(null, { status: 204, headers: noStore });
    const result: unknown = await response.json();
    const safe = safeResult(path, result);
    if (!safe) {
      return liveError('ระบบสตรีมตอบกลับไม่ถูกต้อง', 503);
    }
    return NextResponse.json(safe, { status: response.status, headers: noStore });
  } catch {
    return liveError('ระบบสตรีมยังไม่พร้อม กรุณาลองอีกครั้ง', 503);
  }
}
