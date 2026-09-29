import type { ParsedLiveProductAddCurl } from '@live-hub/tiktok-client';

export type ProductAddOutcome = 'accepted' | 'rejected' | 'unverified';
export type ProductAddSender = (
  request: ParsedLiveProductAddCurl,
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
    return 'unverified';
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unverified';
  const data = result as Record<string, unknown>;
  const code = data.code ?? data.status_code;
  if (code === 0 || code === '0' || data.success === true) return 'accepted';
  if (code !== undefined || data.success === false) {
    // Only record an integer code. Response messages may contain account or request details.
    console.warn('TikTok Shop product add rejected application request', {
      code: typeof code === 'number' && Number.isSafeInteger(code) ? code
        : typeof code === 'string' && /^\d{1,9}$/.test(code) ? Number(code) : null,
    });
    return 'rejected';
  }
  return 'unverified';
};
