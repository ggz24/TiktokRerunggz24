import { accountIdPattern, liveError, proxyLive } from '../../../../_proxy';

export const dynamic = 'force-dynamic';

const maxChunkBytes = 33 * 1024 * 1024;

export async function PUT(
  request: Request,
  context: { params: Promise<{ uploadId: string; index: string }> },
) {
  const { uploadId, index } = await context.params;
  if (!accountIdPattern.test(uploadId) || !/^\d{1,6}$/.test(index)) {
    return liveError('ข้อมูลอัปโหลดไม่ถูกต้อง', 400);
  }
  if (request.headers.get('content-type') !== 'application/octet-stream' || !request.body) {
    return liveError('ข้อมูลอัปโหลดไม่ถูกต้อง', 415);
  }
  const size = Number(request.headers.get('content-length'));
  if (Number.isFinite(size) && size > maxChunkBytes) return liveError('ชิ้นข้อมูลใหญ่เกินไป', 413);
  return proxyLive(request, `/api/v1/live/uploads/${uploadId}/chunks/${index}`, 'PUT', {
    contentType: 'application/octet-stream',
    body: request.body,
    timeoutMs: 900_000,
  });
}
