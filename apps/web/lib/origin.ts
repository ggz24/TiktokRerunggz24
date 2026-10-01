// Behind Caddy/the ggz24.com front proxy, request.url is http://internal-host, so comparing the
// browser's Origin to request.url.origin always fails. Compare against the public Host instead.
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host') ||
    new URL(request.url).host;
  return originHost === host;
}
