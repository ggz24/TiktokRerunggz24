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
  const outcome = (value: unknown) =>
    ['accepted', 'rejected', 'unverified', 'none'].includes(String(value)) ? value : null;
  const round = (value: unknown) => {
    if (!value) return null;
    const plan = asRecord(value);
    return {
      index: Number.isSafeInteger(plan.index) && Number(plan.index) >= 0 ? plan.index : 0,
      ...(typeof plan.videoId === 'string' && accountIdPattern.test(plan.videoId)
        ? { videoId: plan.videoId }
        : {}),
      ...(typeof plan.productSetId === 'string' && accountIdPattern.test(plan.productSetId)
        ? { productSetId: plan.productSetId }
        : {}),
      addProducts: plan.addProducts === true,
      pinProduct: plan.pinProduct === true,
      ...(typeof plan.pinProductId === 'string' && /^\d{8,24}$/.test(plan.pinProductId)
        ? { pinProductId: plan.pinProductId }
        : {}),
    };
  };
  if (path.endsWith('/product-pin')) return { hasRequest: data.hasRequest === true };
  if (path.endsWith('/pin-product')) return { outcome: outcome(data.outcome) };
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
          videoRotation: Array.isArray(settings.videoRotation)
            ? settings.videoRotation
                .filter((id) => typeof id === 'string' && accountIdPattern.test(id))
                .slice(0, 100)
            : [],
          productSetRotation: Array.isArray(settings.productSetRotation)
            ? settings.productSetRotation
                .filter((id) => typeof id === 'string' && accountIdPattern.test(id))
                .slice(0, 100)
            : [],
          autoAddProducts: settings.autoAddProducts !== false,
          autoPinProduct: settings.autoPinProduct === true,
          productPinSelections: Object.fromEntries(
            Object.entries(asRecord(settings.productPinSelections))
              .filter(
                ([id, product]) =>
                  accountIdPattern.test(id) &&
                  typeof product === 'string' &&
                  /^\d{8,24}$/.test(product),
              )
              .slice(0, 100),
          ),
        },
        phase: ['idle', 'live', 'resting'].includes(String(item.phase)) ? item.phase : 'idle',
        phaseStartedAt: typeof item.phaseStartedAt === 'string' ? item.phaseStartedAt : null,
        lastError: typeof item.lastError === 'string' ? item.lastError : null,
        completedRounds:
          Number.isSafeInteger(item.completedRounds) && Number(item.completedRounds) >= 0
            ? item.completedRounds
            : 0,
        activeRound: round(item.activeRound),
        nextRound: round(item.nextRound),
        productsOutcome: outcome(item.productsOutcome),
        pinOutcome: outcome(item.pinOutcome),
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
          ...(path.endsWith('/start-auto')
            ? { pinOutcome: outcome(data.pinOutcome), round: data.round }
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
      if (
        path.endsWith('/auto-settings') ||
        path.endsWith('/product-pin') ||
        path.endsWith('/pin-product')
      ) {
        const data = asRecord(await response.json().catch(() => null));
        const allowed = new Set([
          'เลือกคลิปที่พร้อมใช้งานจากคลังของคุณเท่านั้น',
          'เลือกชุดสินค้าที่ผูกกับบัญชีนี้เท่านั้น',
          'เลือกชุดของบัญชีนี้หรือชุดที่ยังไม่ผูกบัญชีเท่านั้น',
          'session ในคำขอสินค้าไม่ตรงกับบัญชีนี้ กรุณาบันทึก cURL ใหม่',
          'บันทึก cURL ปักหมุดของบัญชีนี้ก่อนเปิดปักหมุดอัตโนมัติ',
          'เลือกชุดสินค้าสำหรับปักหมุดก่อน',
          'สินค้าที่เลือกปักหมุดไม่ได้อยู่ในชุดนี้',
          'ชุดสินค้าถูกลบหรือผูกกับบัญชีอื่น',
          'เริ่ม LIVE ของบัญชีนี้ก่อนปักหมุด',
          'ไม่ยืนยันผลปักหมุด กรุณาตรวจใน TikTok Shop',
          'กำลังเริ่มหรือเปลี่ยนรอบไลฟ์ กรุณารอแล้วบันทึกอีกครั้ง',
        ]);
        if (typeof data.error === 'string' && allowed.has(data.error))
          return liveError(data.error, response.status);
        if (path.endsWith('/product-pin') && response.status === 400)
          return liveError(
            'รูปแบบ cURL ปักหมุดยังไม่รองรับ กรุณาส่งคำขอจากปุ่ม Pin เพื่อตรวจสอบ',
            400,
          );
        if (path.endsWith('/product-pin') && response.status === 409)
          return liveError('session ใน cURL ไม่ตรงกับบัญชีนี้ กรุณาเลือกบัญชีให้ถูกต้อง', 409);
      }
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
