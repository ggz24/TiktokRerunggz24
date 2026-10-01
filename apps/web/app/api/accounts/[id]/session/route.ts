import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { isSameOrigin } from '@/lib/origin';

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const username = await currentUser();
  if (!username) return fail('กรุณาเข้าสู่ระบบ', 401);
  if (!isSameOrigin(request)) return fail('คำขอไม่ถูกต้อง', 403);
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return fail('ระบบบัญชียังไม่พร้อมใช้งาน', 503);
  const { id } = await context.params;
  if (!uuid.test(id)) return fail('บัญชีไม่ถูกต้อง', 400);
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return fail('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('รูปแบบข้อมูลไม่ถูกต้อง', 400);
  }
  const values = body as { curl?: unknown; sessionid?: unknown } | null;
  if (
    !values ||
    typeof values !== 'object' ||
    (typeof values.curl === 'string') === (typeof values.sessionid === 'string') ||
    (typeof values.curl === 'string' && values.curl.length > 100_000)
  ) {
    return fail('ข้อมูล session ไม่ถูกต้อง', 400);
  }
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const response = await fetch(new URL(`/api/v1/accounts/${id}/session`, base), {
      method: 'POST',
      headers: {
        'x-internal-token': token,
        'x-livehub-owner': username,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        typeof values.curl === 'string' ? { curl: values.curl } : { sessionid: values.sessionid },
      ),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 400) {
      return fail('ข้อมูล session ไม่ถูกต้อง กรุณาตรวจ cURL หรือ sessionid อีกครั้ง', 400);
    }
    if (response.status === 404) return fail('ไม่พบบัญชีนี้', 404);
    if (response.status === 409) {
      return fail(
        'session นี้เป็นของบัญชี TikTok คนละไอดีกับการ์ดนี้ กรุณาคัดลอก cURL จากไอดีที่ถูกต้อง',
        409,
      );
    }
    if (response.status === 422) {
      return fail('TikTok ไม่ยืนยัน session นี้ กรุณาใช้ session ที่เข้าสู่ระบบอยู่', 422);
    }
    if (!response.ok) return fail('อัปเดต session ไม่สำเร็จ กรุณาลองอีกครั้ง', 503);
    const result = await response.json();
    return NextResponse.json({ item: result.item }, { headers: noStore });
  } catch {
    return fail('อัปเดต session ไม่สำเร็จ กรุณาลองอีกครั้ง', 503);
  }
}
