import { isSameOrigin } from '@/lib/origin';
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
function headers(request: Request) {
  const origin = request.headers.get('origin') ?? '';
  return {
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    ...(extensionOrigin.test(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        }
      : {}),
  };
}
export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: extensionOrigin.test(request.headers.get('origin') ?? '') ? 204 : 403,
    headers: headers(request),
  });
}
export async function POST(request: Request) {
  const h = headers(request);
  const error = (status: number, message: string) =>
    NextResponse.json({ error: message }, { status, headers: h });
  // This explicit extension relay uses a scoped bearer token, never browser cookies.
  // Account management remains behind the normal authenticated same-origin proxy.
  const origin = request.headers.get('origin');
  if (origin && !extensionOrigin.test(origin) && !isSameOrigin(request))
    return error(403, 'คำขอไม่ถูกต้อง');
  const authorization = request.headers.get('authorization') ?? '';
  if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return error(401, 'กรุณาจับคู่ส่วนเชื่อม');
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return error(415, 'ข้อมูลไม่ถูกต้อง');
  if (Number(request.headers.get('content-length')) > 1500000) return error(413, 'ข้อมูลยาวเกินไป');
  const body = await request.text();
  if (new TextEncoder().encode(body).length > 1500000) return error(413, 'ข้อมูลยาวเกินไป');
  try {
    JSON.parse(body);
    const r = await fetch(
      `${process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000'}/api/v1/chat-bridge/relay`,
      {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      },
    );
    return NextResponse.json(await r.json(), { status: r.status, headers: h });
  } catch {
    return error(503, 'ติดต่อส่วนเชื่อมไม่ได้');
  }
}
