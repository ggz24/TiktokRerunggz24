import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { isSameOrigin } from '@/lib/origin';
import { apiPath } from '@/lib/base-path';
import { BoxphoneError, boxphoneApi, boxphoneCatalog, boxphoneTarget } from '@/lib/boxphone';
import {
  RelayError,
  dropAgent,
  listDevices,
  onlineAgents,
  submitForSerial,
} from '@/lib/boxphone-relay';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ action: string }> };
const actions = new Set([
  'ai-settings',
  'devices',
  'screenshot',
  'screen-size',
  'detect-chat',
  'prepare-chat',
  'check-keyboard',
  'setup-keyboard',
  'send',
  'transcribe',
  'questions',
  'plan-questions',
  'open-live',
  'check-live',
  'transcribe-video',
  'channel-transcript',
]);
// These run on the server with keys saved there, so they work from any computer.
const aiActions = new Set([
  'ai-settings',
  'transcribe',
  'questions',
  'plan-questions',
  'transcribe-video',
  'channel-transcript',
]);
/** One double-clickable file: batch lines first, then the PowerShell script after a marker. */
function installerCmd(script: string): string {
  return [
    '@echo off',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8) -split ('#--P'+'S--'))[1]"`,
    'echo.',
    'pause',
    'exit /b',
    '#--PS--',
    script,
  ].join('\r\n');
}
const assets = new Set([
  'app.js',
  'continuous.mjs',
  'message-policy.mjs',
  'theme.css',
  'livehub.css',
  'livehub.mjs',
  'target-policy.mjs',
  'credentials.mjs',
  'plan.mjs',
]);
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const source = (name: string) => path.resolve(process.cwd(), '../../tools/boxphone-lab', name);
const error = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers });
async function proxy(request: Request, context: Context) {
  const username = await currentUser();
  if (!username) return error('กรุณาเข้าสู่ระบบ', 401);
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.method !== 'GET' && !isSameOrigin(request))
  )
    return error('คำขอไม่ถูกต้อง', 403);
  if (process.env.BOXPHONE_ENABLED !== 'true')
    return error(
      'ยังไม่ได้เปิด Boxphone บนเครื่องนี้ เปิด Start-Boxphone.cmd แล้วอัปเดตบริการเว็บ',
      503,
    );
  const { action } = await context.params;
  if (request.method === 'GET' && (action === 'view' || assets.has(action))) {
    try {
      if (action === 'view') {
        const html = (await readFile(source('index.html'), 'utf8'))
          .replace('__TOKEN__', 'livehub-session')
          .replace('<title>Boxphone Lab</title>', '<title>Boxphone · Live Hub</title>')
          .replace(
            '</head>',
            `<meta name="lab-api-root" content="${apiPath('/api/boxphone')}"><meta name="lab-livehub-root" content="${apiPath('')}"><meta name="lab-owner" content="${encodeURIComponent(username)}"><link rel="stylesheet" href="${apiPath('/api/boxphone/livehub.css')}"><link rel="stylesheet" href="${apiPath('/api/boxphone/theme.css')}"></head>`,
          )
          .replace('<body>', '<body class="cyber-shell boxphone-theme">')
          .replace('src="/app.js"', `src="${apiPath('/api/boxphone/app.js')}"`);
        return new Response(html, {
          headers: {
            ...headers,
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
          },
        });
      }
      const file =
        action === 'livehub.css' ? path.resolve(process.cwd(), 'app/cyber.css') : source(action);
      return new Response(await readFile(file, 'utf8'), {
        headers: {
          ...headers,
          'Content-Type': action.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'text/javascript; charset=utf-8',
        },
      });
    } catch {
      return error('โหลดหน้า Boxphone ไม่สำเร็จ', 503);
    }
  }
  if (request.method === 'GET' && action === 'catalog') {
    try {
      return NextResponse.json(await boxphoneCatalog(username), { headers });
    } catch {
      return error('โหลดคลังวิดีโอและช่องไม่สำเร็จ', 503);
    }
  }
  // Hosted mode: the computers holding the phones connect out to this service (see boxphone-relay).
  const remote = process.env.BOXPHONE_REMOTE === 'agent';

  // --- computers: list, pair, remove, installer ---
  if (request.method === 'GET' && action === 'computers') {
    if (!remote) return NextResponse.json({ mode: 'local', computers: [] }, { headers });
    try {
      const { data } = await boxphoneApi(username, 'GET', '/api/v1/boxphone/agents');
      const online = new Map(onlineAgents(username).map((a) => [a.id, a]));
      const saved = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
      const computers = saved.map((c) => ({
        id: String(c.id),
        name: String(c.name),
        online: online.has(String(c.id)),
        lastSeen:
          online.get(String(c.id))?.lastSeen ??
          (c.lastSeen ? Date.parse(String(c.lastSeen)) : null),
      }));
      const legacy = online.get('legacy');
      if (legacy)
        computers.unshift({
          id: 'legacy',
          name: legacy.name,
          online: true,
          lastSeen: legacy.lastSeen,
        });
      return NextResponse.json({ mode: 'agent', computers }, { headers });
    } catch {
      return error('โหลดรายการคอมไม่สำเร็จ', 503);
    }
  }
  if (request.method === 'POST' && action === 'pair') {
    if (!remote) return error('โหมดนี้ใช้ตัวเชื่อมในเครื่องโดยตรง ไม่ต้องจับคู่คอม', 409);
    try {
      const { status, data } = await boxphoneApi(username, 'POST', '/api/v1/boxphone/pairings', {});
      return NextResponse.json(data, { status, headers });
    } catch (e) {
      return error(e instanceof BoxphoneError ? e.message : 'สร้างรหัสจับคู่ไม่สำเร็จ', 503);
    }
  }
  if (request.method === 'POST' && action === 'computer-remove') {
    if (!remote) return error('ไม่พบคำสั่ง', 404);
    const body: unknown = await request.json().catch(() => null);
    const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
      return error('ลบได้เฉพาะคอมที่จับคู่ด้วยรหัส (คอมเครื่องหลักแบบเดิมลบจากหน้านี้ไม่ได้)', 400);
    try {
      const { status, data } = await boxphoneApi(
        username,
        'DELETE',
        `/api/v1/boxphone/agents/${id}`,
      );
      if (status === 200) dropAgent(id);
      return NextResponse.json(data, { status, headers });
    } catch (e) {
      return error(e instanceof BoxphoneError ? e.message : 'ลบคอมไม่สำเร็จ', 503);
    }
  }
  if (request.method === 'GET' && action === 'installer') {
    if (!remote) return error('โหมดนี้ไม่ต้องติดตั้งตัวแทน', 409);
    const code = new URL(request.url).searchParams.get('code') ?? '';
    if (!/^[A-Za-z0-9-]{8,12}$/.test(code)) return error('รหัสจับคู่ไม่ถูกต้อง', 400);
    try {
      const script = await readFile(source('installer/setup.ps1'), 'utf8');
      const origin = (process.env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(
        /\/$/,
        '',
      );
      const server = `${origin}${apiPath('')}`;
      return new Response(
        installerCmd(script.replace('__SERVER__', server).replace('__CODE__', code)),
        {
          headers: {
            ...headers,
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="Boxphone-Setup.cmd"',
          },
        },
      );
    } catch {
      return error('สร้างตัวติดตั้งไม่สำเร็จ', 503);
    }
  }

  if (
    !(request.method === 'GET' && action === 'health') &&
    !(request.method === 'POST' && actions.has(action))
  )
    return error('ไม่พบคำสั่ง', 404);
  const token = process.env.BOXPHONE_BRIDGE_TOKEN;
  const base = process.env.BOXPHONE_INTERNAL_URL || 'http://127.0.0.1:8767';
  const needsBridge = !aiActions.has(action);
  if (!remote && needsBridge && !token) return error('ยังไม่ได้ตั้งค่าตัวเชื่อม Boxphone', 503);
  // Local mode only: never forward device commands to arbitrary URLs.
  if (
    !remote &&
    needsBridge &&
    !['http://127.0.0.1:8767', 'http://host.docker.internal:8767'].includes(base)
  )
    return error('ปลายทาง Boxphone ต้องเป็นบริการในเครื่องนี้', 503);
  if (remote && request.method === 'GET' && action === 'health') {
    const computers = onlineAgents(username).length;
    return computers > 0
      ? NextResponse.json({ app: 'boxphone-lab', mode: 'agent', computers }, { headers })
      : error(
          'คอมที่ต่อโทรศัพท์ยังไม่เชื่อมต่อ ตรวจว่าเปิดเครื่องอยู่และตัวเชื่อม Boxphone ทำงานอยู่',
          503,
        );
  }
  let body: Uint8Array | undefined;
  let data: Record<string, unknown> = {};
  if (request.method === 'POST') {
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return error('ข้อมูลไม่ถูกต้อง', 415);
    const limit =
      action === 'transcribe'
        ? 34 * 1024 * 1024
        : action === 'plan-questions'
          ? 1024 * 1024
          : 128 * 1024;
    if (Number(request.headers.get('content-length')) > limit) return error('ข้อมูลยาวเกินไป', 413);
    const reader = request.body?.getReader();
    if (!reader) return error('ข้อมูลไม่ถูกต้อง', 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) {
        await reader.cancel();
        return error('ข้อมูลยาวเกินไป', 413);
      }
      chunks.push(part.value);
    }
    body = Buffer.concat(chunks);
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return error('ข้อมูลไม่ถูกต้อง', 400);
      data = parsed as Record<string, unknown>;
    } catch {
      return error('ข้อมูลไม่ถูกต้อง', 400);
    }
  }
  try {
    // --- AI runs on the server with keys saved there, so any computer works without setup ---
    if (aiActions.has(action)) {
      if (action === 'channel-transcript') {
        const target = await boxphoneTarget(username, data.accountId);
        const { status, data: heard } = await boxphoneApi(
          username,
          'POST',
          '/api/v1/boxphone/transcribe-video',
          {
            accountId: data.accountId,
            seconds: data.seconds,
            transcriptionKey: data.transcriptionKey,
          },
        );
        if (status === 200) await boxphoneTarget(username, data.accountId, target.key);
        return NextResponse.json(status === 200 ? { ...heard, target } : heard, {
          status,
          headers,
        });
      }
      if (action === 'transcribe-video') {
        const { status, data: heard } = await boxphoneApi(
          username,
          'POST',
          '/api/v1/boxphone/transcribe-video',
          {
            videoId: data.videoId,
            startSeconds: data.startSeconds ?? 0,
            seconds: data.seconds ?? 30,
            transcriptionKey: data.transcriptionKey,
          },
        );
        if (status === 200) delete heard.target;
        return NextResponse.json(heard, { status, headers });
      }
      const { status, data: result } = await boxphoneApi(
        username,
        'POST',
        `/api/v1/boxphone/${action}`,
        data,
      );
      return NextResponse.json(result, { status, headers });
    }

    let forwardTarget: Awaited<ReturnType<typeof boxphoneTarget>> | undefined;
    if (action === 'send' || action === 'open-live' || action === 'check-live') {
      // The target URL/handle comes from an owned verified account, never from browser input.
      const target = await boxphoneTarget(username, data.targetAccountId, data.targetKey);
      forwardTarget = target;
      data = { ...data, target };
      body = Buffer.from(JSON.stringify(data));
    }
    let status: number;
    let result: Record<string, unknown>;
    if (remote) {
      if (action === 'devices') {
        const listed = await listDevices(username);
        return NextResponse.json(
          { devices: listed.devices, computers: listed.computers },
          { headers },
        );
      }
      const serial = typeof data.serial === 'string' ? data.serial : '';
      if (!serial) return error('ไม่ได้ระบุโทรศัพท์', 400);
      const relayed = await submitForSerial(username, serial, {
        action,
        method: 'POST',
        body: body ? Buffer.from(body).toString('utf8') : null,
      });
      status = relayed.status;
      try {
        const parsed: unknown = JSON.parse(relayed.body);
        result =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
      } catch {
        return error('ตัวเชื่อมบนคอมตอบกลับไม่ถูกต้อง', 502);
      }
    } else {
      const r = await fetch(`${base}/${action === 'health' ? 'health' : 'api/' + action}`, {
        method: request.method,
        headers: {
          'content-type': 'application/json',
          'x-boxphone-bridge-token': token as string,
          'x-lab-token': token as string,
          'x-livehub-owner': username,
        },
        body: body as BodyInit | undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(125000),
      });
      status = r.status;
      result = await r.json();
    }
    const ok = status >= 200 && status < 300;
    return NextResponse.json(
      { ...result, ...(ok && forwardTarget ? { target: forwardTarget } : {}) },
      { status, headers },
    );
  } catch (e) {
    if (e instanceof RelayError) return error(e.message, e.status);
    if (e instanceof BoxphoneError) return error(e.message, e.status);
    return error('เชื่อมต่อ Boxphone ไม่สำเร็จ เปิด Start-Boxphone.cmd บนเครื่องที่ต่อมือถือ', 503);
  }
}
export const GET = proxy;
export const POST = proxy;
