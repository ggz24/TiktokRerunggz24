import { currentUser } from '@/lib/auth';
import { accountIdPattern, liveError } from '../../../_proxy';

export const dynamic = 'force-dynamic';

const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

export async function GET(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const username = await currentUser();
  if (!username) return liveError('กรุณาเข้าสู่ระบบ', 401);
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return liveError('ระบบสตรีมยังไม่พร้อม', 503);
  const { videoId } = await context.params;
  if (!accountIdPattern.test(videoId)) return liveError('วิดีโอไม่ถูกต้อง', 400);
  const range = request.headers.get('range');
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const upstream = await fetch(new URL(`/api/v1/live/videos/${videoId}/file`, base), {
      headers: {
        'x-internal-token': token,
        'x-livehub-owner': username,
        ...(range ? { range } : {}),
      },
      cache: 'no-store',
      signal: request.signal,
    });
    if (upstream.status === 404) return liveError('ไม่พบวิดีโอ', 404);
    if (upstream.status === 422) return liveError('วิดีโอนี้ยังแปลงไฟล์ไม่เสร็จ', 422);
    if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
      return liveError('เปิดวิดีโอไม่สำเร็จ', 503);
    }
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    for (const name of passthrough) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return liveError('เปิดวิดีโอไม่สำเร็จ', 503);
  }
}
