import { tokenize } from './live-product-curl';

/**
 * A copied TikTok page request (a statistics page, for example) parsed as data. Never executes a shell command.
 * The request is replayed unchanged with the account's own session, so only TikTok hosts are accepted.
 */
export interface ParsedStatsCurl {
  url: string;
  host: string;
  path: string;
  method: 'GET' | 'POST';
  body?: string;
  /** Allow-listed request headers only (no cookie, user agent or referer). */
  headers: Record<string, string>;
  cookieHeader?: string;
  userAgent?: string;
  referer?: string;
}

const HOST = /(^|\.)(tiktok\.com|tiktokshop\.com|tiktok-shops\.com)$/i;
const SAFE_HEADER =
  /^(accept|accept-language|content-type|authorization|x-secsdk-csrf-token|x-csrf-token|x-tt-[a-z0-9-]+|tt-[a-z0-9-]+)$/;

function invalid(): never {
  throw new Error('Invalid TikTok statistics cURL.');
}

export function parseStatsCurl(input: string): ParsedStatsCurl {
  let tokens: string[];
  try {
    tokens = tokenize(input);
  } catch {
    invalid();
  }
  if (!/^(curl|curl\.exe)$/i.test(tokens[0] ?? '')) invalid();
  let urlText: string | undefined;
  let method: string | undefined;
  let body: string | undefined;
  let cookieHeader: string | undefined;
  const headers = new Map<string, string>();
  for (let i = 1; i < tokens.length; i += 1) {
    const item = tokens[i];
    const equal = item.indexOf('=');
    const flag = item.startsWith('--') && equal > 0 ? item.slice(0, equal) : item;
    const inline = flag === item ? undefined : item.slice(equal + 1);
    const value = () => {
      const next = inline ?? tokens[++i];
      if (!next) invalid();
      return next;
    };
    if (flag === '--url') {
      if (urlText) invalid();
      urlText = value();
    } else if (flag === '-X' || flag === '--request') {
      if (method) invalid();
      method = value().toUpperCase();
    } else if (flag === '-H' || flag === '--header') {
      const header = value();
      const colon = header.indexOf(':');
      if (colon < 1) invalid();
      const name = header.slice(0, colon).trim().toLowerCase();
      const headerValue = header.slice(colon + 1).trim();
      if (!/^[a-z0-9-]+$/.test(name) || headers.has(name) || /[\r\n\0]/.test(headerValue))
        invalid();
      headers.set(name, headerValue);
    } else if (flag === '-b' || flag === '--cookie') {
      if (cookieHeader || headers.has('cookie')) invalid();
      cookieHeader = value();
    } else if (['--data', '--data-raw', '--data-binary', '-d'].includes(flag)) {
      if (body !== undefined) invalid();
      body = value();
      if (body.startsWith('@')) invalid();
    } else if (
      ['--compressed', '-L', '--location', '-s', '--silent', '-S', '--show-error'].includes(flag)
    ) {
      continue;
    } else if (item.startsWith('-')) {
      invalid();
    } else if (!urlText) {
      urlText = item;
    } else {
      invalid();
    }
  }
  if (!urlText || (body !== undefined && body.length > 64_000)) invalid();
  const verb = method ?? (body !== undefined ? 'POST' : 'GET');
  if (verb !== 'GET' && verb !== 'POST') invalid();
  if (verb === 'GET' && body !== undefined) invalid();
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    invalid();
  }
  if (
    url.protocol !== 'https:' ||
    !HOST.test(url.hostname) ||
    /^\d+(\.\d+){3}$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    urlText.length > 8_000
  )
    invalid();
  const referer = headers.get('referer');
  if (referer) {
    try {
      const ref = new URL(referer);
      if (ref.protocol !== 'https:' || !HOST.test(ref.hostname)) invalid();
    } catch {
      invalid();
    }
  }
  const cookie = cookieHeader ?? headers.get('cookie');
  // eslint-disable-next-line no-control-regex
  if (cookie && (cookie.length > 16_000 || /[^\x20-\x7e]/.test(cookie) || cookie.startsWith('@')))
    invalid();
  const userAgent = headers.get('user-agent');
  // eslint-disable-next-line no-control-regex
  if (userAgent && (userAgent.length > 500 || /[^\x20-\x7e]/.test(userAgent))) invalid();
  if (verb === 'POST' && body === undefined) invalid();
  return {
    url: url.href,
    host: url.hostname,
    path: url.pathname,
    method: verb,
    ...(body !== undefined ? { body } : {}),
    headers: Object.fromEntries([...headers].filter(([name]) => SAFE_HEADER.test(name))),
    ...(cookie ? { cookieHeader: cookie } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(referer ? { referer } : {}),
  };
}
