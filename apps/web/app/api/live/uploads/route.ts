import { liveError, proxyLive } from '../_proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  }
  const body = await request.text();
  if (body.length > 4096) return liveError('ข้อมูลไม่ถูกต้อง', 413);
  return proxyLive(request, '/api/v1/live/uploads', 'POST', {
    contentType: 'application/json',
    body,
  });
}
