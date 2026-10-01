import type { ParsedLiveProductAddCurl } from '@live-hub/tiktok-client';

export type ProductAddOutcome = 'accepted' | 'rejected' | 'unverified';
/** The add and remove requests share one replay path; only these fields are used. */
export type ReplayableShopRequest = Pick<
  ParsedLiveProductAddCurl,
  'url' | 'body' | 'userAgent' | 'referer' | 'region'
>;
export type ProductAddSender = (
  request: ReplayableShopRequest & { roomId?: string },
  cookieHeader: string,
) => Promise<ProductAddOutcome>;

/** Replay only the validated product-add request. Never log or return its signed URL or cookie. */
export const sendLiveProductAdd: ProductAddSender = async (request, cookieHeader) => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: 'https://shop.tiktok.com',
      cookie: cookieHeader,
      ...(request.userAgent ? { 'user-agent': request.userAgent } : {}),
      ...(request.referer ? { referer: request.referer } : {}),
      ...(request.region ? { 'x-tt-store-region': request.region } : {}),
    },
    body: request.body,
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const target = new URL(request.url).pathname.split('/').pop();
  if (!response.ok) {
    console.warn('TikTok Shop product add rejected HTTP request', { status: response.status });
    return 'rejected';
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 64_000) return 'unverified';
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    console.info('TikTok Shop request returned a non-JSON body', {
      action: target,
      status: response.status,
    });
    return 'unverified';
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unverified';
  const data = result as Record<string, unknown>;
  const code = data.code ?? data.status_code;
  console.info('TikTok Shop request completed', {
    action: target,
    status: response.status,
    code: typeof code === 'number' || typeof code === 'string' ? String(code).slice(0, 12) : null,
    success: typeof data.success === 'boolean' ? data.success : null,
  });
  if (code === 0 || code === '0' || data.success === true) return 'accepted';
  if (code !== undefined || data.success === false) {
    // Only record an integer code. Response messages may contain account or request details.
    console.warn('TikTok Shop product add rejected application request', {
      code:
        typeof code === 'number' && Number.isSafeInteger(code)
          ? code
          : typeof code === 'string' && /^\d{1,9}$/.test(code)
            ? Number(code)
            : null,
    });
    return 'rejected';
  }
  return 'unverified';
};
