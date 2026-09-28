import { accountIdPattern, liveError, proxyLive } from '../../../_proxy';

export const dynamic = 'force-dynamic';

export async function PUT(request: Request, context: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await context.params;
  if (!accountIdPattern.test(accountId)) return liveError('บัญชีไม่ถูกต้อง', 400);
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  }
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > 16_384) return liveError('ข้อมูลสตรีมใหญ่เกินไป', 413);
  if (!request.body) return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 400);
  let body: unknown;
  try {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        return liveError('ข้อมูลสตรีมใหญ่เกินไป', 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return liveError('รูปแบบข้อมูลไม่ถูกต้อง', 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !['rtmpUrl', 'streamKey', 'videoId'].includes(key)) ||
    typeof (body as { rtmpUrl?: unknown }).rtmpUrl !== 'string' ||
    typeof (body as { streamKey?: unknown }).streamKey !== 'string' ||
    typeof (body as { videoId?: unknown }).videoId !== 'string'
  ) {
    return liveError('ข้อมูลสตรีมไม่ถูกต้อง', 400);
  }
  return proxyLive(request, `/api/v1/live/sessions/${accountId}/config`, 'PUT', {
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
