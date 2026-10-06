export class BoxphoneError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const items = (data: Row): Row[] => (Array.isArray(data.items) ? data.items.map(record) : []);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function internal(owner: string, path: string, body?: Row) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) throw new BoxphoneError('ระบบบัญชียังไม่พร้อม', 503);
  const r = await fetch(new URL(path, process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000'), {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-internal-token': token,
      'x-livehub-owner': owner,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(body ? 60000 : 10000),
  });
  if (!r.ok)
    throw new BoxphoneError(
      r.status === 404
        ? 'ไม่พบช่องหรือวิดีโอในบัญชีนี้'
        : r.status === 409
          ? 'ช่องนี้ยังไม่ส่งสตรีม หรือกำลังมีงานถอดเสียง กรุณาลองใหม่'
          : r.status === 422
            ? 'อ่านเสียงไม่ได้ ตรวจว่าวิดีโอแปลงเสร็จ มีเสียง และช่วงเวลาที่เลือกอยู่ในไฟล์'
            : 'ระบบคลังวิดีโอยังไม่พร้อม',
      [400, 404, 409, 422].includes(r.status) ? r.status : 503,
    );
  return record(await r.json());
}

export async function boxphoneCatalog(owner: string) {
  const [accounts, videos, sessions] = await Promise.all([
    internal(owner, '/api/v1/accounts'),
    internal(owner, '/api/v1/live/videos'),
    internal(owner, '/api/v1/live/sessions'),
  ]);
  const channels = await Promise.all(
    items(accounts).map(async (account) => {
      const session = items(sessions).find((s) => s.accountId === account.id) || {};
      const ai = await internal(owner, `/api/v1/ai-comments/${account.id}`).catch(
        () => ({}) as Row,
      );
      const settings = record(ai.settings);
      return {
        id: account.id,
        alias: account.alias,
        handle: account.verifiedHandle || '',
        connected: account.verificationStatus === 'connected',
        status: session.status || 'idle',
        videoId: session.videoId || null,
        videoName: session.videoName || null,
        startedAt: session.startedAt || null,
        aiEnabled: settings.enabled === true,
        aiReady: ai.aiReady === true,
        chatReady: ai.chatReady === true,
      };
    }),
  );
  return {
    channels,
    videos: items(videos).map((v) => ({
      id: v.id,
      name: v.name,
      status: v.status || 'ready',
      sizeBytes: v.sizeBytes,
    })),
  };
}

export async function boxphoneTarget(owner: string, accountId: unknown, expected?: unknown) {
  if (typeof accountId !== 'string' || !uuid.test(accountId))
    throw new BoxphoneError('เลือกช่อง LIVE ให้เครื่องนี้ก่อน');
  const [accounts, state] = await Promise.all([
    internal(owner, '/api/v1/accounts'),
    internal(owner, `/api/v1/live/sessions/${accountId}/boxphone-target`),
  ]);
  const account = items(accounts).find((a) => a.id === accountId);
  if (
    !account ||
    account.verificationStatus !== 'connected' ||
    typeof account.verifiedHandle !== 'string'
  )
    throw new BoxphoneError('ช่องนี้ยังไม่ยืนยันบัญชี', 409);
  const handle = account.verifiedHandle.replace(/^@/, '');
  const session = record(state.item);
  if (
    !/^[A-Za-z0-9._]{1,32}$/.test(handle) ||
    session.status !== 'live' ||
    !session.startedAt ||
    !session.videoId
  )
    throw new BoxphoneError('ช่องนี้ยังไม่ส่งสตรีม LIVE ใน Live Hub', 409);
  const key = `${accountId}:${session.startedAt}:${state.roomId || ''}:${session.videoId}`;
  if (expected !== undefined && expected !== key)
    throw new BoxphoneError(
      'ช่องเริ่มไลฟ์ใหม่หรือเปลี่ยนวิดีโอแล้ว ยกเลิกงานเก่าและเริ่มใหม่',
      409,
    );
  return {
    accountId,
    handle,
    key,
    startedAt: session.startedAt,
    roomId: state.roomId || null,
    videoId: session.videoId,
  };
}

export async function boxphoneAudio(owner: string, data: Row) {
  return internal(owner, '/api/v1/live/boxphone/audio', {
    ...(data.accountId
      ? { accountId: data.accountId }
      : { videoId: data.videoId, startSeconds: data.startSeconds ?? 0 }),
    seconds: data.seconds ?? 30,
  });
}
