import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const username = await currentUser();
  if (!username) return NextResponse.json({ error: 'กรุณาเข้าสู่ระบบ' }, { status: 401 });
  const token = process.env.INTERNAL_API_TOKEN;
  const { id } = await context.params;
  if (!token || !uuid.test(id)) return new Response(null, { status: 404 });
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const response = await fetch(new URL(`/api/v1/accounts/${id}/avatar`, base), {
      headers: { 'x-internal-token': token, 'x-livehub-owner': username },
      cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
    });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) return new Response(null, { status: 404 });
    return new Response(await response.arrayBuffer(), {
      headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=600' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
