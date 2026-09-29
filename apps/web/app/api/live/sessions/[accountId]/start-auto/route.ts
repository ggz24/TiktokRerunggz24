import { accountIdPattern, liveError, proxyLive } from '../../../_proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await context.params;
  if (!accountIdPattern.test(accountId)) return liveError('บัญชีไม่ถูกต้อง', 400);
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  }
  let body: unknown;
  try {
    const source = await request.text();
    if (source.length > 512) return liveError('ข้อมูลใหญ่เกินไป', 413);
    body = JSON.parse(source);
  } catch {
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { title?: unknown }).title !== 'string') {
    return liveError('กรุณากรอกชื่อไลฟ์', 400);
  }
  return proxyLive(request, `/api/v1/live/sessions/${accountId}/start-auto`, 'POST', {
    contentType: 'application/json', body: JSON.stringify(body), timeoutMs: 65_000,
  });
}
