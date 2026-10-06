import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { completeJob, nextJob } from '@/lib/boxphone-relay';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ op: string }> };
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers });
const MAX_RESULT_CHARS = 48 * 1024 * 1024;

/** The computer that holds the phones authenticates with its own long random token, never a user session. */
function authorized(request: Request): boolean {
  const expected = process.env.BOXPHONE_AGENT_TOKEN ?? '';
  if (process.env.BOXPHONE_REMOTE !== 'agent' || expected.length < 32) return false;
  const supplied = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request, context: Context) {
  const { op } = await context.params;
  if (op !== 'next') return fail('ไม่พบคำสั่ง', 404);
  if (!authorized(request)) return fail('ไม่ได้รับอนุญาต', 401);
  const job = await nextJob(25_000);
  return job
    ? NextResponse.json(job, { headers })
    : new NextResponse(null, { status: 204, headers });
}

export async function POST(request: Request, context: Context) {
  const { op } = await context.params;
  if (op !== 'result') return fail('ไม่พบคำสั่ง', 404);
  if (!authorized(request)) return fail('ไม่ได้รับอนุญาต', 401);
  if (Number(request.headers.get('content-length')) > MAX_RESULT_CHARS)
    return fail('ข้อมูลยาวเกินไป', 413);
  let data: { id?: unknown; status?: unknown; body?: unknown };
  try {
    data = await request.json();
  } catch {
    return fail('ข้อมูลไม่ถูกต้อง', 400);
  }
  if (
    typeof data.id !== 'string' ||
    !Number.isInteger(data.status) ||
    typeof data.body !== 'string'
  )
    return fail('ข้อมูลไม่ถูกต้อง', 400);
  return NextResponse.json(
    { accepted: completeJob(data.id, { status: data.status as number, body: data.body }) },
    { headers },
  );
}
