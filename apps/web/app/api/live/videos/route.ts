import { liveError, proxyLive } from '../_proxy';

export const dynamic = 'force-dynamic';

const maxVideoBytes = 8 * 1024 * 1024 * 1024;

export async function GET(request: Request) {
  return proxyLive(request, '/api/v1/live/videos', 'GET');
}

export async function POST(request: Request) {
  if (request.headers.get('content-type') !== 'video/mp4') {
    return liveError('รองรับเฉพาะวิดีโอ MP4', 415);
  }
  const fileName = request.headers.get('x-file-name');
  if (!fileName || fileName.length > 600 || !request.body) {
    return liveError('ชื่อไฟล์หรือเนื้อหาไม่ถูกต้อง', 400);
  }
  const size = Number(request.headers.get('content-length'));
  if (Number.isFinite(size) && size > maxVideoBytes) {
    return liveError('ไฟล์วิดีโอใหญ่เกิน 8 GB', 413);
  }
  return proxyLive(request, '/api/v1/live/videos', 'POST', {
    contentType: 'video/mp4',
    fileName,
    body: request.body,
    timeoutMs: 3_600_000,
  });
}
