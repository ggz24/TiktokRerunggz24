import { NextResponse } from 'next/server';
import { accountIdPattern, liveAuthorization, liveError, noStore } from '../../live/_proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ path?: string[] }> };

/** Saved statistics page requests. Only the list, one source, and its run action are reachable. */
async function forward(request: Request, context: Context) {
  const parts = (await context.params).path ?? [];
  const mutation = request.method !== 'GET';
  const okPath =
    parts.length === 0 ||
    (parts.length === 1 && accountIdPattern.test(parts[0])) ||
    (parts.length === 2 && accountIdPattern.test(parts[0]) && parts[1] === 'run');
  if (!okPath) return liveError('ไม่พบคำสั่ง', 404);
  const allowed =
    (parts.length === 0 && ['GET', 'POST'].includes(request.method)) ||
    (parts.length === 1 && ['PATCH', 'DELETE'].includes(request.method)) ||
    (parts.length === 2 && request.method === 'POST');
  if (!allowed) return liveError('ไม่พบคำสั่ง', 404);
  const auth = await liveAuthorization(request, mutation);
  if (auth.response) return auth.response;
  let body: string | undefined;
  if (request.method === 'POST' || request.method === 'PATCH') {
    if (Number(request.headers.get('content-length')) > 130_000)
      return liveError('ข้อมูลยาวเกินไป', 413);
    body = (await request.text()) || '{}';
    if (body.length > 130_000) return liveError('ข้อมูลยาวเกินไป', 413);
  }
  try {
    const response = await fetch(
      new URL(
        `/api/v1/stats-sources${parts.length ? '/' + parts.join('/') : ''}`,
        process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000',
      ),
      {
        method: request.method,
        headers: {
          ...auth.headers,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      },
    );
    const data: unknown = await response.json().catch(() => ({}));
    // The API's own messages are Thai and safe; anything unexpected becomes a generic error.
    if (!response.ok && !(data && typeof data === 'object' && 'error' in data))
      return liveError('ระบบสถิติยังไม่พร้อม กรุณาลองใหม่', 503);
    return NextResponse.json(data, { status: response.status, headers: noStore });
  } catch {
    return liveError('ระบบสถิติยังไม่พร้อม กรุณาลองใหม่', 503);
  }
}
export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
