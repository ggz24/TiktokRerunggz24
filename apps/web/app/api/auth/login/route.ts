import { NextResponse } from 'next/server';
import { cookieName, makeSession } from '@/lib/auth';
export async function POST(request: Request) {
  const configuredUsername = process.env.APP_USERNAME;
  const configuredPassword = process.env.APP_PASSWORD;
  if (!configuredUsername || !configuredPassword || !process.env.SESSION_SECRET) {
    return NextResponse.json({ error: 'ระบบเข้าสู่ระบบยังไม่พร้อม' }, { status: 503 });
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
    return NextResponse.json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(cookieName, makeSession(username), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 86400,
  });
  return response;
}
