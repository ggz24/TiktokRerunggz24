import { accountIdPattern, liveError, proxyLive } from '../../../_proxy';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ accountId: string }> };
export async function POST(request: Request, context: Context) {
  const { accountId } = await context.params;
  if (!accountIdPattern.test(accountId)) return liveError('บัญชีไม่ถูกต้อง', 400);
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  const body = await request.text();
  if (body.length > 1024) return liveError('ข้อมูลใหญ่เกินไป', 413);
  return proxyLive(request, `/api/v1/live/sessions/${accountId}/pin-product`, 'POST', {
    contentType: 'application/json',
    body,
  });
}
