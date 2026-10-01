import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { isSameOrigin } from '@/lib/origin';

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };
const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

async function readSettingsBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4096) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

async function authorize(request: Request, context: { params: Promise<{ id: string }> }) {
  const username = await currentUser();
  if (!username) return { response: error('กรุณาเข้าสู่ระบบ', 401) };
  if (!isSameOrigin(request)) {
    return { response: error('คำขอไม่ถูกต้อง', 403) };
  }
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return { response: error('ระบบบัญชียังไม่พร้อมใช้งาน', 503) };
  const { id } = await context.params;
  if (!accountIdPattern.test(id)) return { response: error('บัญชีไม่ถูกต้อง', 400) };
  return {
    id,
    headers: { 'x-internal-token': token, 'x-livehub-owner': username },
  };
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorize(request, context);
  if ('response' in authorization) return authorization.response;
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return error('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  }

  let body: unknown;
  try {
    body = await readSettingsBody(request);
  } catch {
    return error('รูปแบบข้อมูลไม่ถูกต้อง', 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !['alias', 'liveTitle'].includes(key)) ||
    typeof (body as { alias?: unknown }).alias !== 'string' ||
    typeof (body as { liveTitle?: unknown }).liveTitle !== 'string'
  ) {
    return error('การตั้งค่าบัญชีไม่ถูกต้อง', 400);
  }

  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const response = await fetch(new URL(`/api/v1/accounts/${authorization.id}`, base), {
      method: 'PATCH',
      headers: { ...authorization.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return error('ไม่พบบัญชีนี้', 404);
    if (response.status === 400) return error('การตั้งค่าบัญชีไม่ถูกต้อง', 400);
    if (!response.ok) return error('บันทึกการตั้งค่าไม่สำเร็จ กรุณาลองอีกครั้ง', 503);
    const result = await response.json();
    return NextResponse.json({ item: result.item }, { headers: noStore });
  } catch {
    return error('บันทึกการตั้งค่าไม่สำเร็จ กรุณาลองอีกครั้ง', 503);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorize(request, context);
  if ('response' in authorization) return authorization.response;
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const response = await fetch(new URL(`/api/v1/accounts/${authorization.id}`, base), {
      method: 'DELETE',
      headers: authorization.headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return error('ไม่พบบัญชีนี้', 404);
    if (response.status === 409) return error('บัญชีนี้กำลังสตรีม กรุณาหยุดสตรีมก่อนลบ', 409);
    if (response.status !== 204) return error('ลบบัญชีไม่สำเร็จ กรุณาลองอีกครั้ง', 503);
    return new Response(null, { status: 204, headers: noStore });
  } catch {
    return error('ลบบัญชีไม่สำเร็จ กรุณาลองอีกครั้ง', 503);
  }
}
