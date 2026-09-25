/**
 * Parse a narrowly scoped DevTools "Copy as cURL (bash)" request for account import.
 * The command is only tokenized: it is never passed to a shell or executed.
 * Callers must keep the returned cookie on the server and out of logs.
 */

const PROFILE_URL = 'https://www.tiktok.com/api/update/profile/';
const MAX_INPUT_LENGTH = 64_000;
const MAX_TOKENS = 80;
const MAX_COOKIE_LENGTH = 16_000;

const ALLOWED_HEADERS = new Set([
  'accept',
  'accept-language',
  'cookie',
  'priority',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'user-agent',
  'x-secsdk-csrf-request',
  'x-secsdk-csrf-version',
]);

export interface ParsedAccountImportCurl {
  method: 'HEAD';
  url: typeof PROFILE_URL;
  cookieHeader: string;
  userAgent?: string;
  claimedHandle?: string;
}

/** Fixed errors avoid reflecting a pasted session value back to the browser or logs. */
function invalid(reason: string): never {
  throw new Error(`Invalid account import cURL: ${reason}.`);
}

/** A small POSIX shell lexer that accepts quoting and line continuations only. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let active = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '\\' && quote !== "'") {
      if (next === '\n') {
        index += 1;
        continue;
      }
      if (next === '\r' && input[index + 2] === '\n') {
        index += 2;
        continue;
      }
      if (quote === '"' && (next === '"' || next === '\\')) {
        current += next;
        active = true;
        index += 1;
        continue;
      }
      invalid('unsupported escape');
    }

    if (quote === null) {
      if (char === "'" || char === '"') {
        quote = char;
        active = true;
      } else if (char === '\r' || char === '\n') {
        invalid('line continuation is missing');
      } else if (/\s/.test(char)) {
        if (active) tokens.push(current);
        current = '';
        active = false;
      } else if (/[;&|<>`$(){}#]/.test(char)) {
        invalid('shell syntax is unsupported');
      } else {
        current += char;
        active = true;
      }
    } else if (char === quote) {
      quote = null;
    } else if (quote === '"' && (char === '$' || char === '`')) {
      invalid('shell expansion is unsupported');
    } else if (char === '\r' || char === '\n' || char === '\0') {
      invalid('control character');
    } else {
      current += char;
    }

    if (tokens.length > MAX_TOKENS) invalid('too many arguments');
  }

  if (quote !== null) invalid('unclosed quote');
  if (active) tokens.push(current);
  if (tokens.length > MAX_TOKENS) invalid('too many arguments');
  return tokens;
}

function validateCookieHeader(value: string): void {
  if (value.length === 0 || value.length > MAX_COOKIE_LENGTH || /[^\x20-\x7e]/.test(value)) {
    invalid('cookie header is invalid');
  }

  let hasSession = false;
  for (const piece of value.split(';')) {
    const part = piece.trim();
    const equalIndex = part.indexOf('=');
    if (equalIndex < 1 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(part.slice(0, equalIndex))) {
      invalid('cookie header is invalid');
    }
    const name = part.slice(0, equalIndex).toLowerCase();
    if (['sessionid', 'sessionid_ss', 'sid_tt'].includes(name) && part.slice(equalIndex + 1)) {
      hasSession = true;
    }
  }
  if (!hasSession) invalid('session cookie is missing');
}

function claimedHandleFromReferer(value: string): string {
  const match = /^https:\/\/www\.tiktok\.com\/@([A-Za-z0-9._]{1,32})\/?$/.exec(value);
  if (!match) invalid('referer is invalid');
  return match[1];
}

/** Parse a raw TikTok profile HEAD cURL command. No network or shell I/O occurs. */
export function parseAccountImportCurl(input: string): ParsedAccountImportCurl {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_LENGTH) {
    invalid('input is empty or too large');
  }
  if (/\0/.test(input)) invalid('control character');

  const tokens = tokenize(input.trim());
  if (tokens[0] !== 'curl') invalid('command must start with curl');

  let url: string | undefined;
  let method: string | undefined;
  let cookieHeader: string | undefined;
  let userAgent: string | undefined;
  let claimedHandle: string | undefined;
  let seenCompressed = false;
  const seenHeaders = new Set<string>();

  function valueForOption(index: number, inline?: string): { value: string; next: number } {
    const value = inline ?? tokens[index + 1];
    if (!value || (inline === undefined && value.startsWith('-')))
      invalid('option value is missing');
    return { value, next: inline === undefined ? index + 1 : index };
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equalIndex = token.indexOf('=');
    const option = token.startsWith('--') && equalIndex > 0 ? token.slice(0, equalIndex) : token;
    const inline = option === token ? undefined : token.slice(equalIndex + 1);

    if (option === '--url') {
      const result = valueForOption(index, inline);
      if (url !== undefined) invalid('URL is duplicated');
      url = result.value;
      index = result.next;
    } else if (option === '-X' || option === '--request') {
      const result = valueForOption(index, inline);
      if (method !== undefined) invalid('method is duplicated');
      method = result.value;
      index = result.next;
    } else if (option === '-b' || option === '--cookie') {
      const result = valueForOption(index, inline);
      if (cookieHeader !== undefined || seenHeaders.has('cookie')) invalid('cookie is duplicated');
      cookieHeader = result.value;
      index = result.next;
    } else if (option === '-H' || option === '--header') {
      const result = valueForOption(index, inline);
      const colonIndex = result.value.indexOf(':');
      if (colonIndex < 1) invalid('header is invalid');
      const name = result.value.slice(0, colonIndex).trim().toLowerCase();
      const value = result.value.slice(colonIndex + 1).trim();
      if (
        !/^[a-z0-9-]+$/.test(name) ||
        !ALLOWED_HEADERS.has(name) ||
        seenHeaders.has(name) ||
        value.length === 0 ||
        value.length > (name === 'cookie' ? MAX_COOKIE_LENGTH : 2_000) ||
        /[^\x20-\x7e]/.test(value)
      ) {
        invalid('header is invalid or duplicated');
      }
      seenHeaders.add(name);
      if (name === 'cookie') {
        if (cookieHeader !== undefined) invalid('cookie is duplicated');
        cookieHeader = value;
      } else if (name === 'user-agent') {
        userAgent = value;
      } else if (name === 'referer') {
        claimedHandle = claimedHandleFromReferer(value);
      }
      index = result.next;
    } else if (option === '--compressed') {
      if (inline !== undefined || seenCompressed) invalid('option is duplicated or invalid');
      seenCompressed = true;
      continue;
    } else if (token.startsWith('-')) {
      invalid('unsupported option');
    } else if (url === undefined) {
      url = token;
    } else {
      invalid('unexpected argument');
    }
  }

  if (url !== PROFILE_URL) invalid('URL must be the TikTok profile endpoint');
  if (method !== 'HEAD') invalid('method must be HEAD');
  if (cookieHeader === undefined) invalid('cookie header is missing');
  validateCookieHeader(cookieHeader);

  return {
    method: 'HEAD',
    url: PROFILE_URL,
    cookieHeader,
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(claimedHandle === undefined ? {} : { claimedHandle }),
  };
}
