import { accountIdPattern, liveError, proxyLive } from '../../../_proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await context.params;
  if (!accountIdPattern.test(uploadId)) return liveError('รหัสอัปโหลดไม่ถูกต้อง', 400);
  return proxyLive(request, `/api/v1/live/uploads/${uploadId}/complete`, 'POST', {
    timeoutMs: 14_400_000,
  });
}
