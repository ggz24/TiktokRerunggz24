import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const username = await currentUser();
  if (!username) {
    return NextResponse.json({ error: 'กรุณาเข้าสู่ระบบ' }, { status: 401, headers: noStore });
  }
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'คำขอไม่ถูกต้อง' }, { status: 403, headers: noStore });
  }
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: 'ระบบบัญชียังไม่พร้อมใช้งาน' },
      { status: 503, headers: noStore },
    );
  }
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'บัญชีไม่ถูกต้อง' }, { status: 400, headers: noStore });
  }
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const response = await fetch(new URL(`/api/v1/accounts/${id}/verify`, base), {
      method: 'POST',
      headers: { 'x-internal-token': token, 'x-livehub-owner': username },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 404) {
      return NextResponse.json({ error: 'ไม่พบบัญชีนี้' }, { status: 404, headers: noStore });
    }
    if (!response.ok) {
      return NextResponse.json(
        { error: 'ตรวจการเชื่อมต่อไม่สำเร็จ กรุณาลองอีกครั้ง' },
        { status: 503, headers: noStore },
      );
    }
    const result = await response.json();
    return NextResponse.json({ item: result.item }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: 'ตรวจการเชื่อมต่อไม่สำเร็จ กรุณาลองอีกครั้ง' },
      { status: 503, headers: noStore },
    );
  }
}
