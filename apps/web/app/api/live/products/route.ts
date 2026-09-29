import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

export async function POST(request: Request) {
  const username = await currentUser();
  if (!username) return error('กรุณาเข้าสู่ระบบ', 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return error('คำขอไม่ถูกต้อง', 403);
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return error('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  }
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return error('ระบบสินค้ายังไม่พร้อม', 503);
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > 110_000) return error('cURL ยาวเกินไป', 413);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('รูปแบบข้อมูลไม่ถูกต้อง', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return error('ข้อมูลไม่ถูกต้อง', 400);
  const values = body as Record<string, unknown>;
  if (
    (values.action !== 'preview' && values.action !== 'send') ||
    typeof values.curl !== 'string' ||
    values.curl.length > 100_000 ||
    (values.accountId !== undefined && typeof values.accountId !== 'string') ||
    Object.keys(values).some((key) => !['action', 'curl', 'accountId'].includes(key))
  )
    return error('ข้อมูลไม่ถูกต้อง', 400);
  const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
  const path =
    values.action === 'preview' ? '/api/v1/live/products/preview' : '/api/v1/live/products/add';
  try {
    const response = await fetch(new URL(path, base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': token,
        'x-livehub-owner': username,
      },
      body: JSON.stringify({
        curl: values.curl,
        ...(values.accountId ? { accountId: values.accountId } : {}),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 400) return error('cURL ไม่ตรงกับคำขอเพิ่มสินค้า LIVE', 400);
    if (response.status === 404) return error('ไม่พบบัญชีที่เลือก', 404);
    if (response.status === 409)
      return error(
        'ยังไม่มีห้อง LIVE ให้ส่งสินค้า บันทึกเป็นชุดสินค้าแล้วกดส่งเพื่อรอเริ่มไลฟ์',
        409,
      );
    if (response.status === 422)
      return error('TikTok Shop ปฏิเสธคำขอ ตรวจ session และคัดลอก cURL ใหม่', 422);
    if (!response.ok) return error('ระบบสินค้ายังไม่พร้อม กรุณาลองอีกครั้ง', 503);
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object') return error('อ่านผลคำขอไม่สำเร็จ', 503);
    const data = result as Record<string, unknown>;
    if (values.action === 'preview') {
      if (typeof data.roomId !== 'string' || !Array.isArray(data.productIds)) {
        return error('อ่านรายการสินค้าไม่สำเร็จ', 503);
      }
      return NextResponse.json(
        {
          roomId: data.roomId,
          productIds: data.productIds,
          hasCookie: data.hasCookie === true,
        },
        { headers: noStore },
      );
    }
    if (data.outcome !== 'accepted' && data.outcome !== 'unverified') {
      return error('อ่านผลคำขอไม่สำเร็จ', 503);
    }
    return NextResponse.json(
      {
        outcome: data.outcome,
        roomId: data.roomId,
        productCount: data.productCount,
      },
      { status: response.status, headers: noStore },
    );
  } catch {
    return error('ระบบสินค้ายังไม่พร้อม กรุณาลองอีกครั้ง', 503);
  }
}
