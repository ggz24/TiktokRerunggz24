import { NextResponse } from 'next/server';
import { cookieName, makeSession } from '@/lib/auth';

const failedLogins = new Map<string, { count: number; resetAt: number }>();
const loginWindowMs = 15 * 60 * 1000;
const maxFailedLogins = 10;

function clientKey(request: Request): string {
  return (
    request.headers.get('x-real-ip')?.trim().slice(0, 128) ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 128) ||
    'local'
  );
}

function addFailure(key: string, now: number): void {
  const previous = failedLogins.get(key);
  const count = previous && previous.resetAt > now ? previous.count + 1 : 1;
  failedLogins.set(key, { count, resetAt: now + loginWindowMs });
  if (failedLogins.size > 10_000) {
    for (const [address, value] of failedLogins) {
      if (value.resetAt <= now) failedLogins.delete(address);
    }
    if (failedLogins.size > 10_000) failedLogins.delete(failedLogins.keys().next().value!);
  }
}

export async function POST(request: Request) {
  const configuredUsername = process.env.APP_USERNAME;
  const configuredPassword = process.env.APP_PASSWORD;
  if (!configuredUsername || !configuredPassword || !process.env.SESSION_SECRET) {
    return NextResponse.json({ error: 'ระบบเข้าสู่ระบบยังไม่พร้อม' }, { status: 503 });
  }
  const key = clientKey(request);
  const now = Date.now();
  const failures = failedLogins.get(key);
  if (failures && failures.resetAt > now && failures.count >= maxFailedLogins) {
    return NextResponse.json(
      { error: 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาที' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((failures.resetAt - now) / 1000)) },
      },
    );
  }
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    return NextResponse.json({ error: 'ข้อมูลเข้าสู่ระบบไม่ถูกต้อง' }, { status: 415 });
  }
  const size = Number(request.headers.get('content-length'));
  if (Number.isFinite(size) && size > 4096) {
    return NextResponse.json({ error: 'ข้อมูลเข้าสู่ระบบไม่ถูกต้อง' }, { status: 413 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'ข้อมูลเข้าสู่ระบบไม่ถูกต้อง' }, { status: 400 });
  }
  const username = (body as { username?: unknown })?.username;
  const password = (body as { password?: unknown })?.password;
  if (username !== configuredUsername || password !== configuredPassword) {
    addFailure(key, now);
    return NextResponse.json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }, { status: 401 });
  }
  failedLogins.delete(key);
  const response = NextResponse.json({ ok: true });
  const hostname = new URL(request.url).hostname;
  response.cookies.set(cookieName, makeSession(username), {
    httpOnly: true,
    sameSite: 'lax',
    secure:
      process.env.PUBLIC_BASE_URL?.startsWith('https://') ||
      (process.env.NODE_ENV === 'production' &&
        hostname !== 'localhost' &&
        hostname !== '127.0.0.1'),
    path: process.env.NEXT_PUBLIC_BASE_PATH || '/',
    maxAge: 86400,
  });
  return response;
}
