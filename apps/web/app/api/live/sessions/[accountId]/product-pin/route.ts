import { accountIdPattern, liveError, proxyLive } from '../../../_proxy';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ accountId: string }> };
export async function GET(request: Request, context: Context) {
  const { accountId } = await context.params;
  if (!accountIdPattern.test(accountId)) return liveError('บัญชีไม่ถูกต้อง', 400);
  return proxyLive(request, `/api/v1/live/sessions/${accountId}/product-pin`, 'GET');
}
export async function PUT(request: Request, context: Context) {
  const { accountId } = await context.params;
  if (!accountIdPattern.test(accountId)) return liveError('บัญชีไม่ถูกต้อง', 400);
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  const body = await request.text();
  if (body.length > 110000) return liveError('ข้อมูลใหญ่เกินไป', 413);
  return proxyLive(request, `/api/v1/live/sessions/${accountId}/product-pin`, 'PUT', {
    contentType: 'application/json',
    body,
  });
}
