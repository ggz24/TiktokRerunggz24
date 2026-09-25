import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

export type ProbeStatus = 'responded' | 'failed' | 'not_run';
export type VerificationStatus = 'connected' | 'pending_verification' | 'disconnected';

export interface TikTokIdentity {
  userId: string;
  username: string;
  avatarUrl?: string;
}

export interface AccountMetadata {
  id: string;
  alias: string;
  claimedHandle?: string;
  verifiedHandle?: string;
  avatarUrl?: string;
  verifiedAt?: string;
  verificationStatus: VerificationStatus;
  probe: ProbeStatus;
  probeHttpStatus: number | null;
  createdAt: string;
}

export interface EncryptedCookie {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export interface StoredAccount extends AccountMetadata, EncryptedCookie {
  ownerId: string;
  verifiedUserId?: string;
  userAgent?: EncryptedCookie;
}

export interface EncryptedAccountSecret extends EncryptedCookie {
  id: string;
  ownerId: string;
  claimedHandle?: string;
  userAgent?: EncryptedCookie;
}

export interface AccountStore {
  list(ownerId: string): Promise<AccountMetadata[]>;
  insert(account: StoredAccount): Promise<AccountMetadata>;
  findEncrypted(ownerId: string, id: string): Promise<EncryptedAccountSecret | null>;
  setVerification(
    ownerId: string,
    id: string,
    identity: TikTokIdentity | null,
  ): Promise<AccountMetadata | null>;
}

export type IdentityLookup = (
  cookieHeader: string,
  userAgent?: string,
) => Promise<TikTokIdentity | null>;

export interface AccountConfig {
  store: AccountStore;
  encryptionKey: Buffer;
  internalToken: string;
  /** Omitted uses TikTok's read-only account info response. */
  identityLookup?: IdentityLookup;
}

export function parseEncryptionKeyHex(value: string | undefined): Buffer {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('ACCOUNT_ENCRYPTION_KEY must be 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}

export function validateAccountConfig(config: AccountConfig): void {
  if (!Buffer.isBuffer(config.encryptionKey) || config.encryptionKey.length !== 32) {
    throw new Error('Account encryption key must be 32 bytes.');
  }
  if (typeof config.internalToken !== 'string' || config.internalToken.length < 32) {
    throw new Error('INTERNAL_API_TOKEN must contain at least 32 characters.');
  }
}

/** Hash both sides to compare a fixed length value and avoid leaking the token in errors. */
export function tokenMatches(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const candidate = createHash('sha256').update(actual).digest();
  const reference = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidate, reference);
}

export function validOwnerId(input: string | string[] | undefined): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9_.@-]{1,128}$/.test(input);
}

export function validAlias(input: unknown): input is string {
  if (typeof input !== 'string' || input.trim().length < 1 || input.trim().length > 80) {
    return false;
  }
  return !Array.from(input).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** AES-256-GCM with a fresh IV and account-bound authenticated data. */
function encryptAccountValue(value: string, key: Buffer, aad: string): EncryptedCookie {
  if (key.length !== 32) throw new Error('Account encryption key must be 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const plaintext = Buffer.from(value, 'utf8');
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  } finally {
    plaintext.fill(0);
  }
}

function decryptAccountValue(encrypted: EncryptedCookie, key: Buffer, aad: string): string {
  if (key.length !== 32) throw new Error('Account encryption key must be 32 bytes.');
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(encrypted.tag);
  const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  try {
    return plaintext.toString('utf8');
  } finally {
    plaintext.fill(0);
  }
}

/** Keep the original AAD format so accounts imported before this update still decrypt. */
export function encryptAccountCookie(
  cookieHeader: string,
  key: Buffer,
  ownerId: string,
  accountId: string,
): EncryptedCookie {
  return encryptAccountValue(cookieHeader, key, `${ownerId}\0${accountId}`);
}

export function decryptAccountCookie(
  encrypted: EncryptedCookie,
  key: Buffer,
  ownerId: string,
  accountId: string,
): string {
  return decryptAccountValue(encrypted, key, `${ownerId}\0${accountId}`);
}

/** The browser User-Agent is stored encrypted and bound to its own purpose. */
export function encryptAccountUserAgent(
  userAgent: string,
  key: Buffer,
  ownerId: string,
  accountId: string,
): EncryptedCookie {
  return encryptAccountValue(userAgent, key, `${ownerId}\0${accountId}\0user-agent`);
}

export function decryptAccountUserAgent(
  encrypted: EncryptedCookie,
  key: Buffer,
  ownerId: string,
  accountId: string,
): string {
  return decryptAccountValue(encrypted, key, `${ownerId}\0${accountId}\0user-agent`);
}

export function newAccountId(): string {
  return randomUUID();
}

/** TikTok's own account-info response identifies the session holder. */
export async function lookupTikTokIdentity(
  cookieHeader: string,
  userAgent?: string,
): Promise<TikTokIdentity | null> {
  const fallbackUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  const response = await fetch('https://www.tiktok.com/passport/web/account/info/', {
    method: 'GET',
    headers: {
      accept: 'application/json',
      cookie: cookieHeader,
      referer: 'https://www.tiktok.com/',
      'user-agent': userAgent ?? fallbackUserAgent,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('TikTok identity response is unavailable.');
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('data' in result)) {
    throw new Error('TikTok identity response is invalid.');
  }
  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new Error('TikTok identity response is invalid.');
  }
  const fields = data as Record<string, unknown>;
  if (typeof fields.error_code === 'number' && fields.error_code !== 0) return null;
  const userId = fields.user_id_str ?? fields.user_id;
  const username = fields.username;
  if (
    !(
      (typeof userId === 'string' || typeof userId === 'number') &&
      /^\d{5,32}$/.test(String(userId))
    ) ||
    typeof username !== 'string' ||
    !/^[A-Za-z0-9._]{1,32}$/.test(username)
  ) {
    return null;
  }
  let avatarUrl: string | undefined;
  if (typeof fields.avatar_url === 'string' && fields.avatar_url.length <= 2_048) {
    try {
      const parsed = new URL(fields.avatar_url);
      if (parsed.protocol === 'https:') avatarUrl = parsed.toString();
    } catch {
      // A missing or malformed avatar does not invalidate the account identity.
    }
  }
  return { userId: String(userId), username, ...(avatarUrl ? { avatarUrl } : {}) };
}
