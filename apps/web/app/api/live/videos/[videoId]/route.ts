import { accountIdPattern, liveError, proxyLive } from '../../_proxy';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await context.params;
  if (!accountIdPattern.test(videoId)) return liveError('วิดีโอไม่ถูกต้อง', 400);
  return proxyLive(request, `/api/v1/live/videos/${videoId}`, 'DELETE');
}
