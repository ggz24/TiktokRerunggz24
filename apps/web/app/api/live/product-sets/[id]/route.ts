import { NextResponse } from 'next/server';
import { proxyProductSet, validSetId } from '../_proxy';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  if (!validSetId(id))
    return NextResponse.json({ error: 'รหัสชุดสินค้าไม่ถูกต้อง' }, { status: 400 });
  return proxyProductSet(request, `/${id}`, 'GET');
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  if (!validSetId(id))
    return NextResponse.json({ error: 'รหัสชุดสินค้าไม่ถูกต้อง' }, { status: 400 });
  return proxyProductSet(request, `/${id}`, 'PATCH');
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  if (!validSetId(id))
    return NextResponse.json({ error: 'รหัสชุดสินค้าไม่ถูกต้อง' }, { status: 400 });
  return proxyProductSet(request, `/${id}`, 'DELETE');
}
