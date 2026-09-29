import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';

export const noStore = { 'Cache-Control': 'no-store' };
export const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function liveError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

export async function liveAuthorization(request: Request, mutation: boolean) {
  const username = await currentUser();
  if (!username) return { response: liveError('กรุณาเข้าสู่ระบบ', 401) };
  if (mutation && request.headers.get('origin') !== new URL(request.url).origin) {
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
      if (path.endsWith('/stop') &&
        ['ended', 'no_room', 'unavailable', 'unverified'].includes(String(data.roomEnd))) {
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
    if (!response.ok) return upstreamError(response.status);
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
