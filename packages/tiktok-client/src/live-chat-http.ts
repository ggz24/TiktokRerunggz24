import { inspectLiveChatResponse, parseLiveChatCurl } from './live-chat-curl';

/** Session-only transport observed to receive code=0/punish=1 on 2026-10-02.
 * The caller must keep the capture encrypted and independently bind its current room.
 * No browser, copied URL signatures or shell execution is required.
 */
export async function sendLiveChatWithSession(
  capture: string,
  options: {
    content: string;
    /** Only supply a room discovered for the verified account by its receiver. */
    roomId?: string;
    currentRoom: () => Promise<string | null>;
    fetch?: typeof fetch;
    now?: number;
  },
) {
  const request = parseLiveChatCurl(capture);
  const content = options.content.trim();
  // eslint-disable-next-line no-control-regex -- reject control bytes before transmission
  if (
    !content ||
    Array.from(content).length > 100 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)
  )
    throw new Error('Chat message must contain 1 to 100 characters.');
  const roomId = options.roomId ?? request.roomId;
  if (!/^\d{8,24}$/.test(roomId) || (await options.currentRoom()) !== roomId)
    throw new Error('Chat capture does not match the current LIVE room.');
  const capturedUrl = new URL(request.url);
  const original = JSON.parse(request.body);
  const url = new URL('https://shop.tiktok.com/api/v1/streamer_desktop/message/chat');
  // Keep only the small routing context used by the verified direct request.
  const params: Record<string, string> = {
    user_language: capturedUrl.searchParams.get('user_language') || 'en',
    locale: capturedUrl.searchParams.get('locale') || 'en',
    aid: String(original.meta.app_id),
    app_name: 'i18n_ecom_alliance',
    device_platform: 'web',
    device_id: '0',
    carrier_region: request.region || capturedUrl.searchParams.get('carrier_region') || 'th',
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const headers: Record<string, string> = {
    ...request.requestHeaders,
    cookie: request.cookieHeader,
    'content-type': 'application/json',
    origin: 'https://shop.tiktok.com',
    referer: request.referer || 'https://shop.tiktok.com/streamer/live/product/dashboard',
  };
  if (request.userAgent) headers['user-agent'] = request.userAgent;
  const body = JSON.stringify({
    content,
    meta: { ...original.meta, room_id: roomId },
    client_start_time_stamp_millisecond: String(options.now ?? Date.now()),
  });
  return postChat(url.href, body, headers, options.fetch ?? fetch);
}

async function postChat(
  url: string,
  body: string,
  headers: Record<string, string>,
  send: typeof fetch,
) {
  try {
    const response = await send(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { ...inspectLiveChatResponse(null), httpStatus: response.status };
    return { ...inspectLiveChatResponse(await response.json()), httpStatus: response.status };
  } catch {
    throw new Error('Chat send result is unknown. Do not automatically retry.');
  }
}

/** Send one fresh captured request unchanged. This does not sign new AI messages. */
export async function sendCapturedLiveChat(
  capture: string,
  options: {
    /** Resolve the account's current room independently, using its authenticated session. */
    currentRoom: () => Promise<string | null>;
    fetch?: typeof fetch;
    now?: number;
  },
) {
  const request = parseLiveChatCurl(capture);
  const timestamp = Number(JSON.parse(request.body).client_start_time_stamp_millisecond);
  const age = (options.now ?? Date.now()) - timestamp;
  if (age < -30000 || age > 5 * 60000)
    throw new Error('Chat capture expired. Supply a fresh successful request.');
  if ((await options.currentRoom()) !== request.roomId)
    throw new Error('Chat capture does not match the current LIVE room.');
  const headers: Record<string, string> = {
    ...request.requestHeaders,
    'content-type': 'application/json',
    cookie: request.cookieHeader,
    origin: 'https://shop.tiktok.com',
  };
  if (request.userAgent) headers['user-agent'] = request.userAgent;
  if (request.referer) headers.referer = request.referer;
  // No retry: a timeout can happen after TikTok accepts the message.
  return postChat(request.url, request.body, headers, options.fetch ?? fetch);
}
