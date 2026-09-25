import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };
const apiBase = () => process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

function internalHeaders(username: string) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return null;
  return {
    'x-internal-token': token,
    'x-livehub-owner': username,
  };
}

function unavailable() {
  return NextResponse.json(
    { error: 'ระบบบัญชียังไม่พร้อมใช้งาน' },
    { status: 503, headers: noStore },
  );
}

export async function GET() {
  const username = await currentUser();
  if (!username) {
    return NextResponse.json({ error: 'กรุณาเข้าสู่ระบบ' }, { status: 401, headers: noStore });
  }
  const headers = internalHeaders(username);
  if (!headers) return unavailable();
  try {
    const response = await fetch(new URL('/api/v1/accounts', apiBase()), {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return unavailable();
    const result = await response.json();
    return NextResponse.json({ items: result.items }, { headers: noStore });
  } catch {
    return unavailable();
  }
}

export async function POST(request: Request) {
  const username = await currentUser();
  if (!username) {
    return NextResponse.json({ error: 'กรุณาเข้าสู่ระบบ' }, { status: 401, headers: noStore });
  }
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'คำขอไม่ถูกต้อง' }, { status: 403, headers: noStore });
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return NextResponse.json(
      { error: 'รูปแบบข้อมูลไม่ถูกต้อง' },
      { status: 415, headers: noStore },
    );
  }
  const headers = internalHeaders(username);
  if (!headers) return unavailable();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'รูปแบบข้อมูลไม่ถูกต้อง' },
      { status: 400, headers: noStore },
    );
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { alias?: unknown }).alias !== 'string' ||
    typeof (body as { curl?: unknown }).curl !== 'string' ||
    (body as { curl: string }).curl.length > 100_000
  ) {
    return NextResponse.json({ error: 'ข้อมูลบัญชีไม่ถูกต้อง' }, { status: 400, headers: noStore });
  }
  try {
    const response = await fetch(new URL('/api/v1/accounts/import', apiBase()), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 400) {
      return NextResponse.json(
        { error: 'cURL ไม่ถูกต้อง กรุณาคัดลอกต้นฉบับจาก DevTools อีกครั้ง' },
        { status: 400, headers: noStore },
      );
    }
    if (response.status === 422) {
      return NextResponse.json(
        { error: 'TikTok ไม่ยืนยัน session นี้ กรุณาคัดลอก cURL ใหม่จากบัญชีที่เข้าสู่ระบบ' },
        { status: 422, headers: noStore },
      );
    }
    if (!response.ok) return unavailable();
    const result = await response.json();
    return NextResponse.json({ item: result.item }, { status: 201, headers: noStore });
  } catch {
    return unavailable();
  }
}
