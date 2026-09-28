import { accountIdPattern, liveError, proxyLive } from '../../../_proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await context.params;
  if (!accountIdPattern.test(accountId)) return liveError('บัญชีไม่ถูกต้อง', 400);
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  }
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > 4096) return liveError('ข้อมูลใหญ่เกินไป', 413);
  let body: unknown;
  try {
    const source = await request.text();
    if (source.length > 4096) return liveError('ข้อมูลใหญ่เกินไป', 413);
    body = JSON.parse(source);
  } catch {
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    Object.keys(body).some((key) => !['videoId', 'title'].includes(key)) ||
    typeof (body as { videoId?: unknown }).videoId !== 'string' ||
    typeof (body as { title?: unknown }).title !== 'string'
  ) {
    return liveError('ข้อมูลห้องไลฟ์ไม่ถูกต้อง', 400);
  }
  return proxyLive(request, `/api/v1/live/sessions/${accountId}/auto-destination`, 'POST', {
    contentType: 'application/json',
    body: JSON.stringify(body),
    timeoutMs: 50_000,
  });
}
