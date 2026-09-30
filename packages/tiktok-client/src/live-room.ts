import { createHash } from 'node:crypto';

const webcastOrigin = 'https://webcast.tiktok.com';

export type RoomSignature = {
  'x-khronos': string;
  'x-ladon': string;
  'x-argus': string;
};

export type RoomSignInput = {
  timestamp: number;
  aid: '8311';
  device_id: string;
  params: Record<string, string>;
  query: string;
  stub: string;
};

export type RoomSigner = (input: RoomSignInput) => Promise<RoomSignature>;

export type CreateRoomInput = {
  title: string;
  categoryId: string;
  cookieHeader: string;
  studioVersion: string;
  deviceId: string;
  installId: string;
  region?: string;
  userAgent?: string;
};

export type CreatedRoom = {
  roomId: string;
  streamId: string;
  rtmpUrl: string;
  streamKey: string;
  shareUrl?: string;
};

export type EndRoomInput = Omit<CreateRoomInput, 'title' | 'categoryId'> & {
  roomId?: string | null;
  streamId?: string | null;
};

/** Checks the current room without changing its state. Unknown responses throw. */
export async function checkTikTokLiveRoom(
  input: EndRoomInput,
  sign: RoomSigner,
  http: typeof fetch = fetch,
): Promise<'open' | 'closed'> {
  if (!input.cookieHeader || /[\r\n]/.test(input.cookieHeader)) throw new Error('Invalid session.');
  const params: Record<string, string> = {
    aid: '8311',
    app_name: 'tiktok_live_studio',
    device_id: input.deviceId,
    install_id: input.installId,
    channel: 'studio',
    version_code: input.studioVersion,
    device_platform: 'windows',
    priority_region: input.region?.toLowerCase() ?? '',
    live_mode: '6',
  };
  const url = new URL('/webcast/room/continue/', webcastOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const signature = await sign({
    timestamp: Math.floor(Date.now() / 1000),
    aid: '8311',
    device_id: input.deviceId,
    params,
    query: url.search.slice(1),
    stub: '',
  });
  if (!validSignature(signature)) throw new Error('Invalid room signature.');
  const response = await http(url, {
    headers: {
      accept: 'application/json',
      cookie: input.cookieHeader,
      ...(input.userAgent ? { 'user-agent': input.userAgent } : {}),
      ...signature,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Room check failed.');
  const root = record(await response.json());
  const statusCode = string(root?.status_code);
  if (!['0', '30003', '30003001'].includes(statusCode)) throw new Error('Room check was rejected.');
  const room = record(record(root?.data)?.room);
  const attrs = record(room?.living_room_attrs);
  const roomId = string(attrs?.room_id_str ?? attrs?.room_id ?? room?.id_str ?? room?.id);
  if (!roomId) return 'closed';
  if (!/^\d{8,24}$/.test(roomId)) throw new Error('Invalid room status.');
  return roomId === input.roomId ? 'open' : 'closed';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function validSignature(value: unknown): value is RoomSignature {
  const headers = record(value);
  return (
    !!headers &&
    ['x-khronos', 'x-ladon', 'x-argus'].every((key) => {
      const header = headers[key];
      return typeof header === 'string' && header.length > 0 && !/[\r\n]/.test(header);
    })
  );
}

export function parseCreatedRoom(payload: unknown): CreatedRoom {
  const root = record(payload);
  if (!root || string(root.status_code) !== '0') {
    throw new Error('TikTok did not create a LIVE room.');
  }
  const data = record(root.data);
  const room = record(data?.room) ?? data;
  const attrs = record(room?.living_room_attrs);
  const roomId = string(attrs?.room_id_str ?? attrs?.room_id ?? room?.id_str ?? room?.id);
  const streamId = string(room?.stream_id_str ?? room?.stream_id);
  const push = string(record(room?.stream_url)?.rtmp_push_url);
  if (!/^\d{8,24}$/.test(roomId) || !/^\d{8,24}$/.test(streamId) || !push) {
    throw new Error('TikTok room response omitted the room ID or push destination.');
  }
  let url: URL;
  try {
    url = new URL(push);
  } catch {
    throw new Error('TikTok returned an invalid push destination.');
  }
  if (
    !['rtmp:', 'rtmps:'].includes(url.protocol) ||
    !['tiktokcdn.com', 'tiktok.com'].some((domain) =>
      url.hostname.toLowerCase().endsWith(`.${domain}`),
    ) ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/(?:[^/]+\/)+[^/]+$/.test(url.pathname)
  ) {
    throw new Error('TikTok returned an untrusted push destination.');
  }
  const slash = url.pathname.lastIndexOf('/');
  const rtmpUrl = `${url.protocol}//${url.host}${url.pathname.slice(0, slash)}`;
  const streamKey = `${url.pathname.slice(slash + 1)}${url.search}`;
  if (!rtmpUrl || !streamKey || rtmpUrl.length > 2048 || streamKey.length > 2048) {
    throw new Error('TikTok returned an invalid push destination.');
  }
  const shareUrl = string(room?.share_url);
  return { roomId, streamId, rtmpUrl, streamKey, ...(shareUrl ? { shareUrl } : {}) };
}

/** Creates a room; it does not start a video encoder or prove viewer visibility. */
export async function createTikTokLiveRoom(
  input: CreateRoomInput,
  sign: RoomSigner,
  http: typeof fetch = fetch,
): Promise<CreatedRoom> {
  if (
    !input.title.trim() ||
    input.title.length > 120 ||
    !/^\d{1,12}$/.test(input.categoryId) ||
    !input.cookieHeader ||
    /[\r\n]/.test(input.cookieHeader) ||
    !/^\d+(?:\.\d+)+$/.test(input.studioVersion) ||
    !/^\d{1,32}$/.test(input.deviceId) ||
    !/^\d{1,32}$/.test(input.installId)
  ) {
    throw new Error('LIVE room settings are incomplete.');
  }
  const region = input.region?.toLowerCase() ?? '';
  if (region && !/^[a-z]{2,8}$/.test(region)) throw new Error('Invalid LIVE region.');
  const params: Record<string, string> = {
    aid: '8311',
    app_name: 'tiktok_live_studio',
    device_id: input.deviceId,
    install_id: input.installId,
    channel: 'studio',
    version_code: input.studioVersion,
    device_platform: 'windows',
    priority_region: region,
    live_mode: '6',
  };
  const body = new URLSearchParams({
    title: input.title.trim(),
    live_studio: '1',
    gen_replay: 'true',
    chat_auth: '1',
    age_restricted: '0',
    cover_uri: '',
    close_room_when_close_stream: 'true',
    hashtag_id: input.categoryId,
    game_tag_id: '0',
    game_bitrate_type: 'high',
    screenshot_cover_status: '1',
    multi_stream_scene: '0',
    gift_auth: '1',
    chat_l2: '1',
    star_comment_switch: 'true',
    multi_stream_source: '1',
    is_group_live_session: 'false',
    open_commercial_content_toggle: 'false',
    commercial_content_promote_myself: 'false',
    commercial_content_promote_third_party: 'false',
    rtc_net_enabled: 'false',
  }).toString();
  const stub = createHash('md5').update(body).digest('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL('/webcast/room/create/', webcastOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const signature = await sign({
    timestamp,
    aid: '8311',
    device_id: input.deviceId,
    params,
    query: url.search.slice(1),
    stub,
  });
  if (!validSignature(signature)) throw new Error('Room signer returned invalid headers.');
  const response = await http(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      cookie: input.cookieHeader,
      ...(input.userAgent ? { 'user-agent': input.userAgent } : {}),
      'x-ss-stub': stub,
      ...signature,
      ...(region ? { 'x-tt-store-region': region } : {}),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`TikTok room creation returned HTTP ${response.status}.`);
  return parseCreatedRoom(await response.json());
}

/** Sends the Live Studio finish status for the account's current room. */
export async function endTikTokLiveRoom(
  input: EndRoomInput,
  sign: RoomSigner,
  http: typeof fetch = fetch,
): Promise<'ended' | 'no_room'> {
  if (
    !input.cookieHeader ||
    /[\r\n]/.test(input.cookieHeader) ||
    !/^\d+(?:\.\d+)+$/.test(input.studioVersion) ||
    !/^\d{1,32}$/.test(input.deviceId) ||
    !/^\d{1,32}$/.test(input.installId)
  ) {
    throw new Error('LIVE room settings are incomplete.');
  }
  const region = input.region?.toLowerCase() ?? '';
  if (region && !/^[a-z]{2,8}$/.test(region)) throw new Error('Invalid LIVE region.');
  const params: Record<string, string> = {
    aid: '8311',
    app_name: 'tiktok_live_studio',
    device_id: input.deviceId,
    install_id: input.installId,
    channel: 'studio',
    version_code: input.studioVersion,
    device_platform: 'windows',
    priority_region: region,
    live_mode: '6',
  };
  const request = async (method: 'GET' | 'POST', path: string, body = '') => {
    const url = new URL(path, webcastOrigin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const stub = body ? createHash('md5').update(body).digest('hex') : '';
    const signature = await sign({
      timestamp: Math.floor(Date.now() / 1000),
      aid: '8311',
      device_id: input.deviceId,
      params,
      query: url.search.slice(1),
      stub,
    });
    if (!validSignature(signature)) throw new Error('Room signer returned invalid headers.');
    const response = await http(url, {
      method,
      headers: {
        accept: 'application/json',
        cookie: input.cookieHeader,
        ...(input.userAgent ? { 'user-agent': input.userAgent } : {}),
        ...(body
          ? {
              'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'x-ss-stub': stub,
            }
          : {}),
        ...signature,
        ...(region ? { 'x-tt-store-region': region } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`TikTok LIVE request returned HTTP ${response.status}.`);
    return response.json() as Promise<unknown>;
  };
  let roomId = input.roomId ?? '';
  let streamId = input.streamId ?? '';
  if (!roomId || !streamId) {
    const result = record(await request('GET', '/webcast/room/continue/'));
    const room = record(record(result?.data)?.room);
    const attrs = record(room?.living_room_attrs);
    roomId = string(attrs?.room_id_str ?? attrs?.room_id ?? room?.id_str ?? room?.id);
    streamId = string(room?.stream_id_str ?? room?.stream_id);
    if (!roomId && !streamId) return 'no_room';
  }
  if (!/^\d{8,24}$/.test(roomId) || !/^\d{8,24}$/.test(streamId)) {
    throw new Error('TikTok did not provide a valid LIVE room identifier.');
  }
  const body = new URLSearchParams({
    status: '4',
    room_id: roomId,
    stream_id: streamId,
  }).toString();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = record(await request('POST', '/webcast/room/ping/anchor/', body));
    const code = string(result?.status_code);
    if (code !== '0' && code !== '30003' && code !== '30003001') {
      throw new Error('TikTok did not accept the LIVE finish request.');
    }
  }
  return 'ended';
}
