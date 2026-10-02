import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { isSameOrigin } from '@/lib/origin';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ accountId: string; action?: string[] }> };
async function proxy(request: Request, context: Context) {
  const headers = { 'Cache-Control': 'no-store' };
  const error = (text: string, status: number) =>
    NextResponse.json({ error: text }, { status, headers });
  const owner = await currentUser();
  if (!owner) return error('กรุณาเข้าสู่ระบบ', 401);
  if (request.method !== 'GET' && !isSameOrigin(request)) return error('คำขอไม่ถูกต้อง', 403);
  const { accountId, action = [] } = await context.params;
  const tail = action.join('/');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId) ||
    !(
      (request.method === 'GET' &&
        (!tail || tail === 'bridge/status' || tail === 'chat-session')) ||
      (request.method === 'PATCH' && tail === 'settings') ||
      (request.method === 'POST' &&
        ['preview', 'models', 'chat-session', 'bridge/pair', 'bridge/revoke'].includes(tail))
    )
  )
    return error('ไม่พบคำสั่ง', 404);
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return error('ระบบ AI ยังไม่พร้อม', 503);
  let body: string | undefined;
  if (request.method !== 'GET') {
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return error('ข้อมูลไม่ถูกต้อง', 415);
    if (Number(request.headers.get('content-length')) > 40000) return error('ข้อมูลยาวเกินไป', 413);
    body = await request.text();
    if (new TextEncoder().encode(body).length > 40000) return error('ข้อมูลยาวเกินไป', 413);
    try {
      JSON.parse(body);
    } catch {
      return error('ข้อมูลไม่ถูกต้อง', 400);
    }
  }
  try {
    const response = await fetch(
      `${process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000'}/api/v1/ai-comments/${accountId}${tail ? '/' + tail : ''}`,
      {
        method: request.method,
        headers: {
          'x-internal-token': token,
          'x-livehub-owner': owner,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(25_000),
      },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status, headers });
  } catch {
    return error('ติดต่อระบบ AI ไม่สำเร็จ', 503);
  }
}
export const GET = proxy;
export const PATCH = proxy;
export const POST = proxy;
