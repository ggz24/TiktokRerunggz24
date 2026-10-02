import { parseShopCurl } from './live-product-curl';

/** Private credentials and signatures: keep this object server-side, never log it. */
export interface ParsedLiveChatCurl {
  requestHeaders?: Record<string, string>;
  url: string;
  body: string;
  roomId: string;
  content: string;
  streamerKey: string;
  cookieHeader: string;
  userAgent?: string;
  referer?: string;
  region?: string;
}

function invalid(): never {
  throw new Error('Invalid TikTok Shop live chat cURL.');
}

/** Parses data only. No shell execution, network request, or message substitution. */
export function parseLiveChatCurl(input: string): ParsedLiveChatCurl {
  try {
    const { data, ...request } = parseShopCurl(input, '/api/v1/streamer_desktop/message/chat');
    const meta =
      data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta)
        ? (data.meta as Record<string, unknown>)
        : null;
    if (
      !meta ||
      typeof data.content !== 'string' ||
      !data.content.trim() ||
      Array.from(data.content).length > 100 ||
      typeof meta.room_id !== 'string' ||
      !/^\d{8,24}$/.test(meta.room_id) ||
      typeof meta.ec_streamer_key !== 'string' ||
      !meta.ec_streamer_key ||
      meta.ec_streamer_key.length > 512 ||
      typeof meta.source !== 'number' ||
      !Number.isInteger(meta.source) ||
      typeof meta.app_id !== 'number' ||
      !Number.isInteger(meta.app_id) ||
      typeof data.client_start_time_stamp_millisecond !== 'string' ||
      !/^\d{13}$/.test(data.client_start_time_stamp_millisecond) ||
      !request.cookieHeader ||
      Object.keys(data).some(
        (k) => !['content', 'meta', 'client_start_time_stamp_millisecond'].includes(k),
      ) ||
      Object.keys(meta).some((k) => !['source', 'app_id', 'room_id', 'ec_streamer_key'].includes(k))
    )
      invalid();
    return {
      ...request,
      roomId: meta.room_id,
      content: data.content,
      streamerKey: meta.ec_streamer_key,
      cookieHeader: request.cookieHeader,
    };
  } catch {
    invalid();
  }
}

/** Safe diagnostic summary. Deliberately omits room, identity, content and all token values. */
export function summarizeLiveChatCapture(request: ParsedLiveChatCurl) {
  const url = new URL(request.url);
  return {
    endpoint: `${url.origin}${url.pathname}`,
    method: 'POST' as const,
    contentLength: Array.from(request.content).length,
    hasCookie: !!request.cookieHeader,
    signatureFields: ['X-Bogus', 'X-Gnarly', 'msToken', 'X-Tts-Oec-Bsid'].filter((k) =>
      url.searchParams.has(k),
    ),
    responseVerified: false,
    receiverConfigured: false,
  };
}

/** API acceptance is not evidence that viewers received a message. No automatic retry. */
export function inspectLiveChatResponse(input: unknown): {
  status: 'accepted' | 'rejected' | 'review_required' | 'unknown';
  code: number | null;
  moderationFlag: number | null;
  deliveryConfirmed: false;
} {
  const response =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const data =
    response.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : {};
  const code = Number.isSafeInteger(response.code) ? (response.code as number) : null;
  const moderationFlag = Number.isSafeInteger(data.punish) ? (data.punish as number) : null;
  // The user verified viewer-visible delivery for two captures with punish=1.
  // Accept that observed flag, without inferring delivery from any API response.
  const status =
    code === null
      ? 'unknown'
      : code !== 0
        ? 'rejected'
        : moderationFlag !== 0 && moderationFlag !== 1
          ? 'review_required'
          : 'accepted';
  return { status, code, moderationFlag, deliveryConfirmed: false };
}
