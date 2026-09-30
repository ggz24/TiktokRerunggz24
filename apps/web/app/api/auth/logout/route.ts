import { NextResponse } from 'next/server';
import { cookieName } from '@/lib/auth';
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(cookieName, '', {
    path: process.env.NEXT_PUBLIC_BASE_PATH || '/',
    maxAge: 0,
  });
  return response;
}
