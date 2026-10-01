import { accountIdPattern, liveError, proxyLive } from '../../_proxy';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ uploadId: string }> };

export async function GET(request: Request, context: Context) {
  const { uploadId } = await context.params;
  if (!accountIdPattern.test(uploadId)) return liveError('รหัสอัปโหลดไม่ถูกต้อง', 400);
  return proxyLive(request, `/api/v1/live/uploads/${uploadId}`, 'GET');
}

export async function DELETE(request: Request, context: Context) {
  const { uploadId } = await context.params;
  if (!accountIdPattern.test(uploadId)) return liveError('รหัสอัปโหลดไม่ถูกต้อง', 400);
  return proxyLive(request, `/api/v1/live/uploads/${uploadId}`, 'DELETE');
}
