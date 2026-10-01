/** Parse a copied TikTok Shop product-add request as data. Never execute a shell command. */
export interface ParsedLiveProductAddCurl {
  url: string;
  body: string;
  roomId: string;
  productIds: string[];
  cookieHeader?: string;
  userAgent?: string;
  referer?: string;
  region?: string;
}

/** Keep the saved product details, but target the room created for this LIVE. */
export function forLiveProductRoom(
  request: ParsedLiveProductAddCurl,
  roomId: string,
): ParsedLiveProductAddCurl {
  if (!/^\d{8,24}$/.test(roomId)) invalid();
  const body = JSON.parse(request.body) as Record<string, unknown>;
  return {
    ...request,
    roomId,
    body: JSON.stringify({ ...body, room_id: roomId }),
  };
}

function invalid(): never {
  throw new Error('Invalid TikTok Shop live product cURL.');
}

function tokenize(input: string): string[] {
  if (!input || input.length > 100_000) invalid();
  const tokens: string[] = [];
  let current = '';
  let active = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (char === '\\' && quote !== "'") {
      if (next === '\n' || (next === '\r' && input[i + 2] === '\n')) {
        i += next === '\r' ? 2 : 1;
        continue;
      }
      if (quote === '"' && (next === '"' || next === '\\')) {
        current += next;
        active = true;
        i += 1;
        continue;
      }
      invalid();
    }
    if (quote === null) {
      if (char === "'" || char === '"') {
        quote = char;
        active = true;
      } else if (/\s/.test(char)) {
        if (active) tokens.push(current);
        current = '';
        active = false;
      } else if (/[;&|<>`$(){}#]/.test(char)) {
        invalid();
      } else {
        current += char;
        active = true;
      }
    } else if (char === quote) {
      quote = null;
    } else if (quote === '"' && (char === '$' || char === '`')) {
      invalid();
    } else if (char === '\0' || char === '\r' || char === '\n') {
      invalid();
    } else {
      current += char;
    }
    if (tokens.length > 100) invalid();
  }
  if (quote !== null) invalid();
  if (active) tokens.push(current);
  if (tokens.length > 100) invalid();
  return tokens;
}

const ADD_PATH = '/api/v1/streamer_desktop/live_product/add';
const DELETE_PATH = '/api/v1/streamer_desktop/live_product/delete';

interface ParsedShopCurl {
  url: string;
  body: string;
  data: Record<string, unknown>;
  cookieHeader?: string;
  userAgent?: string;
  referer?: string;
  region?: string;
}

function parseShopCurl(input: string, pathname: string): ParsedShopCurl {
  const tokens = tokenize(input);
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
      if (!/^[a-z0-9-]+$/.test(name) || headers.has(name) || /[\r\n\0]/.test(headerValue)) {
        invalid();
      }
      headers.set(name, headerValue);
    } else if (flag === '-b' || flag === '--cookie') {
      if (cookieHeader || headers.has('cookie')) invalid();
      cookieHeader = value();
    } else if (['--data', '--data-raw', '--data-binary', '-d'].includes(flag)) {
      if (body !== undefined) invalid();
      body = value();
      if (body.startsWith('@')) invalid();
    } else if (flag === '--compressed' || flag === '-L' || flag === '--location') {
      continue;
    } else if (item.startsWith('-')) {
      invalid();
    } else if (!urlText) {
      urlText = item;
    } else {
      invalid();
    }
  }
  if (!urlText || !body || (method && method !== 'POST') || body.length > 64_000) invalid();
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    invalid();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'shop.tiktok.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== pathname
  )
    invalid();
  if (!headers.get('content-type')?.toLowerCase().startsWith('application/json')) invalid();
  const referer = headers.get('referer');
  if (referer) {
    try {
      const ref = new URL(referer);
      if (ref.origin !== 'https://shop.tiktok.com') invalid();
    } catch {
      invalid();
    }
  }
  const cookie = cookieHeader ?? headers.get('cookie');
  if (cookie && (cookie.length > 16_000 || /[^\x20-\x7e]/.test(cookie) || cookie.startsWith('@'))) {
    invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const data = parsed as Record<string, unknown>;
  const userAgent = headers.get('user-agent');
  const region = headers.get('x-tt-store-region');
  if (userAgent && (userAgent.length > 500 || /[^\x20-\x7e]/.test(userAgent))) invalid();
  if (region && !/^[a-z]{2}$/i.test(region)) invalid();
  return {
    url: url.href,
    body,
    data,
    ...(cookie ? { cookieHeader: cookie } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(referer ? { referer } : {}),
    ...(region ? { region } : {}),
  };
}

function productId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{8,24}$/.test(value)) invalid();
  return value;
}

function uniqueIds(ids: string[]): string[] {
  if (ids.length < 1 || ids.length > 50 || new Set(ids).size !== ids.length) invalid();
  return ids;
}

export function parseLiveProductAddCurl(input: string): ParsedLiveProductAddCurl {
  const { data, ...request } = parseShopCurl(input, ADD_PATH);
  // Streamer Desktop sends an empty room_id while preparing a LIVE that has not started.
  if (typeof data.room_id !== 'string' || (data.room_id !== '' && !/^\d{8,24}$/.test(data.room_id)))
    invalid();
  if (!Array.isArray(data.product_info)) invalid();
  const productIds = uniqueIds(
    data.product_info.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
      return productId((item as Record<string, unknown>).product_id);
    }),
  );
  return { ...request, roomId: data.room_id, productIds };
}

/** A copied "remove products from the LIVE cart" request; replayed unchanged because it is signed. */
export interface ParsedLiveProductDeleteCurl {
  url: string;
  body: string;
  productIds: string[];
  cookieHeader?: string;
  userAgent?: string;
  referer?: string;
  region?: string;
}

export function parseLiveProductDeleteCurl(input: string): ParsedLiveProductDeleteCurl {
  const { data, ...request } = parseShopCurl(input, DELETE_PATH);
  if (!Array.isArray(data.product_ids)) invalid();
  return { ...request, productIds: uniqueIds(data.product_ids.map(productId)) };
}
