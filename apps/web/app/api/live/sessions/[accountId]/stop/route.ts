import { accountIdPattern, liveError, proxyLive } from '../../../_proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await context.params;
  if (!accountIdPattern.test(accountId)) return liveError('บัญชีไม่ถูกต้อง', 400);
  return proxyLive(request, `/api/v1/live/sessions/${accountId}/stop`, 'POST', { timeoutMs: 65_000 });
}
