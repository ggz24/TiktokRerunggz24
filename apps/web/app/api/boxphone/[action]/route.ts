import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { isSameOrigin } from '@/lib/origin';
import { apiPath } from '@/lib/base-path';
import { BoxphoneError, boxphoneAudio, boxphoneCatalog, boxphoneTarget } from '@/lib/boxphone';

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
  if (
    !(request.method === 'GET' && action === 'health') &&
    !(request.method === 'POST' && actions.has(action))
  )
    return error('ไม่พบคำสั่ง', 404);
  const token = process.env.BOXPHONE_BRIDGE_TOKEN;
  if (!token) return error('ยังไม่ได้ตั้งค่าตัวเชื่อม Boxphone', 503);
  const base = process.env.BOXPHONE_INTERNAL_URL || 'http://127.0.0.1:8767';
  // This feature is local only. Never forward keys or device commands to arbitrary URLs.
  if (!['http://127.0.0.1:8767', 'http://host.docker.internal:8767'].includes(base))
    return error('ปลายทาง Boxphone ต้องเป็นบริการในเครื่องนี้', 503);
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
    let bridgeAction = action;
    let audioMeta: Record<string, unknown> | undefined;
    let forwardTarget: Awaited<ReturnType<typeof boxphoneTarget>> | undefined;
    if (action === 'send' || action === 'open-live' || action === 'check-live') {
      // The target URL/handle comes from an owned verified account, never from browser input.
      const target = await boxphoneTarget(username, data.targetAccountId, data.targetKey);
      forwardTarget = target;
      data = { ...data, target };
      body = Buffer.from(JSON.stringify(data));
    }
    if (action === 'transcribe-video' || action === 'channel-transcript') {
      if (action === 'channel-transcript') {
        const target = await boxphoneTarget(username, data.accountId);
        audioMeta = { target };
      }
      const audio = await boxphoneAudio(username, data);
      audioMeta = {
        ...audioMeta,
        videoId: audio.videoId,
        videoName: audio.videoName,
        startSeconds: audio.startSeconds,
        durationSeconds: audio.durationSeconds,
        seconds: audio.seconds,
      };
      bridgeAction = 'transcribe';
      body = Buffer.from(
        JSON.stringify({
          transcriptionKey: data.transcriptionKey,
          audio: audio.audio,
          name: audio.name,
          mime: audio.mime,
        }),
      );
    }
    const r = await fetch(
      `${base}/${bridgeAction === 'health' ? 'health' : 'api/' + bridgeAction}`,
      {
        method: request.method,
        headers: {
          'content-type': 'application/json',
          'x-boxphone-bridge-token': token,
          'x-lab-token': token,
          'x-livehub-owner': username,
        },
        body: body as BodyInit | undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(125000),
      },
    );
    const result = await r.json();
    if (r.ok && audioMeta && action === 'channel-transcript') {
      await boxphoneTarget(username, data.accountId, (audioMeta.target as { key: string }).key);
    }
    return NextResponse.json(
      {
        ...result,
        ...(r.ok ? audioMeta : {}),
        ...(r.ok && forwardTarget ? { target: forwardTarget } : {}),
      },
      { status: r.status, headers },
    );
  } catch (e) {
    if (e instanceof BoxphoneError) return error(e.message, e.status);
    return error('เชื่อมต่อ Boxphone ไม่สำเร็จ เปิด Start-Boxphone.cmd บนเครื่องที่ต่อมือถือ', 503);
  }
}
export const GET = proxy;
export const POST = proxy;
