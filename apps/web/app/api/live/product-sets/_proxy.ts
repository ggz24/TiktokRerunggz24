import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { isSameOrigin } from '@/lib/origin';

const noStore = { 'Cache-Control': 'no-store' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validSetId(id: string): boolean {
  return uuid.test(id);
}

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

export async function proxyProductSet(
  request: Request,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
) {
  const username = await currentUser();
  if (!username) return error('กรุณาเข้าสู่ระบบ', 401);
  if (method !== 'GET' && !isSameOrigin(request)) {
    return error('คำขอไม่ถูกต้อง', 403);
  }
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return error('ระบบชุดสินค้ายังไม่พร้อม', 503);
  let body: string | undefined;
  const bodyless = method === 'POST' && (path.endsWith('/send') || path.endsWith('/remove'));
  if (bodyless) {
    body = undefined;
  } else if (method === 'POST' || method === 'PATCH') {
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return error('รูปแบบข้อมูลไม่ถูกต้อง', 415);
    }
    const length = Number(request.headers.get('content-length'));
    if (Number.isFinite(length) && length > 110_000) return error('cURL ยาวเกินไป', 413);
    try {
      body = await request.text();
      if (body.length > 110_000) return error('cURL ยาวเกินไป', 413);
      JSON.parse(body);
    } catch {
      return error('รูปแบบข้อมูลไม่ถูกต้อง', 400);
    }
  }
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const response = await fetch(new URL(`/api/v1/live/product-sets${path}`, base), {
      method,
      headers: {
        'x-internal-token': token,
        'x-livehub-owner': username,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(bodyless ? 30_000 : 10_000),
    });
    if (response.status === 204) return new Response(null, { status: 204, headers: noStore });
    if (!response.ok) {
      if (path.endsWith('/remove')) {
        if (response.status === 409)
          return error(
            'ชุดนี้ยังไม่ได้บันทึกคำสั่งลบสินค้า กรุณาแก้ไขชุดแล้ววาง cURL ลบสินค้า',
            409,
          );
        if (response.status === 422)
          return error(
            'TikTok Shop ปฏิเสธการลบสินค้า คำขอ cURL ลบที่บันทึกไว้อาจหมดอายุ กรุณาคัดลอกคำขอลบใหม่ขณะ LIVE แล้วแก้ไขชุดสินค้า',
            422,
          );
      }
      if (response.status === 400)
        return error('ข้อมูลชุดสินค้าไม่ถูกต้อง ตรวจชื่อ cURL และบัญชีที่เลือก', 400);
      if (response.status === 404) return error('ไม่พบชุดสินค้าหรือบัญชีที่เลือก', 404);
      if (response.status === 422)
        return error(
          'TikTok Shop ปฏิเสธการเพิ่มสินค้าในห้อง LIVE นี้ คำขอ cURL ที่บันทึกไว้อาจหมดอายุ กรุณาคัดลอกคำขอใหม่ขณะ LIVE แล้วแก้ไขชุดสินค้า',
          422,
        );
      return error('ระบบชุดสินค้ายังไม่พร้อม กรุณาลองอีกครั้ง', 503);
    }
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object') return error('อ่านผลคำขอไม่สำเร็จ', 503);
    return NextResponse.json(result, { status: response.status, headers: noStore });
  } catch {
    return error('ระบบชุดสินค้ายังไม่พร้อม กรุณาลองอีกครั้ง', 503);
  }
}
