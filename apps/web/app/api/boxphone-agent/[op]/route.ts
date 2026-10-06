import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { BoxphoneError, boxphoneApi } from '@/lib/boxphone';
import { allowedPackageRequest, authenticateAgent } from '@/lib/boxphone-agents';
import { completeJob, nextJob } from '@/lib/boxphone-relay';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ op: string }> };
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers });
const MAX_RESULT_CHARS = 48 * 1024 * 1024;
const labDir = () => path.resolve(process.cwd(), '../../tools/boxphone-lab');
const nodeZip = () => process.env.BOXPHONE_NODE_ZIP || '/app/runtime/node-win-x64.zip';

/** Files a computer needs to run the bridge and agent. Tests and the browser page are not included. */
const packageFile = /^[a-z0-9-]+\.mjs$/;
const hashCache = new Map<string, { mtime: number; sha256: string }>();
async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const info = await stat(file);
  const hit = hashCache.get(file);
  if (hit && hit.mtime === info.mtimeMs) return { sha256: hit.sha256, size: info.size };
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const sha256 = hash.digest('hex');
  hashCache.set(file, { mtime: info.mtimeMs, sha256 });
  return { sha256, size: info.size };
}
async function packageFiles(): Promise<{ name: string; file: string }[]> {
  const names = (await readdir(labDir())).filter(
    (n) => packageFile.test(n) && !n.includes('.test.'),
  );
  return [
    ...names.map((name) => ({ name, file: path.join(labDir(), name) })),
    { name: 'run.ps1', file: path.join(labDir(), 'installer', 'run.ps1') },
  ];
}

export async function GET(request: Request, context: Context) {
  const { op } = await context.params;
  try {
    if (op === 'next') {
      const agent = await authenticateAgent(request);
      if (!agent) return fail('ไม่ได้รับอนุญาต', 401);
      const job = await nextJob(agent, 25_000);
      return job
        ? NextResponse.json(job, { headers })
        : new NextResponse(null, { status: 204, headers });
    }
    if (op === 'package' || op === 'file' || op === 'node') {
      if (!(await allowedPackageRequest(request))) return fail('ไม่ได้รับอนุญาต', 401);
      if (op === 'package') {
        const files = await Promise.all(
          (await packageFiles()).map(async (f) => ({
            name: f.name,
            ...(await sha256File(f.file)),
          })),
        );
        let node: { sha256: string; size: number } | null = null;
        try {
          node = await sha256File(nodeZip());
        } catch {
          node = null; // the installer then downloads Node from nodejs.org and checks its published checksum
        }
        return NextResponse.json({ files, node }, { headers });
      }
      if (op === 'node') {
        const info = await stat(nodeZip()).catch(() => null);
        if (!info) return fail('ไม่มีแพ็กเกจ Node บนเซิร์ฟเวอร์', 404);
        return new Response(Readable.toWeb(createReadStream(nodeZip())) as ReadableStream, {
          headers: {
            ...headers,
            'Content-Type': 'application/zip',
            'Content-Length': String(info.size),
          },
        });
      }
      const name = new URL(request.url).searchParams.get('name') ?? '';
      const entry = (await packageFiles()).find((f) => f.name === name);
      if (!entry) return fail('ไม่พบไฟล์', 404);
      return new Response(await readFile(entry.file), {
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  } catch (e) {
    if (e instanceof BoxphoneError) return fail(e.message, e.status);
    return fail('ระบบ Boxphone ยังไม่พร้อม', 503);
  }
  return fail('ไม่พบคำสั่ง', 404);
}

export async function POST(request: Request, context: Context) {
  const { op } = await context.params;
  if (op === 'pair') {
    // The installer trades a one-time code for this computer's own token. The token is shown only here.
    if (process.env.BOXPHONE_REMOTE !== 'agent') return fail('ไม่พบคำสั่ง', 404);
    const body: unknown = await request.json().catch(() => null);
    const input =
      body && typeof body === 'object' ? (body as { code?: unknown; name?: unknown }) : {};
    try {
      const { status, data } = await boxphoneApi('', 'POST', '/api/v1/boxphone/pairings/redeem', {
        code: input.code,
        name: input.name,
      });
      return NextResponse.json(status === 200 ? { token: data.token, name: data.name } : data, {
        status,
        headers,
      });
    } catch (e) {
      return fail(e instanceof BoxphoneError ? e.message : 'จับคู่ไม่สำเร็จ', 503);
    }
  }
  if (op !== 'result') return fail('ไม่พบคำสั่ง', 404);
  const agent = await authenticateAgent(request);
  if (!agent) return fail('ไม่ได้รับอนุญาต', 401);
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
    {
      accepted: completeJob(agent.id, data.id, { status: data.status as number, body: data.body }),
    },
    { headers },
  );
}
