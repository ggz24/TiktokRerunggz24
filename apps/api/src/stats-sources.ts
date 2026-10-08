import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Pool } from 'pg';

const require = createRequire(import.meta.url);
const { parseStatsCurl } =
  require('@live-hub/tiktok-client') as typeof import('@live-hub/tiktok-client');
type ParsedStatsCurl = import('@live-hub/tiktok-client').ParsedStatsCurl;

export class StatsSourceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type StatsSourceInfo = {
  id: string;
  name: string;
  host: string;
  path: string;
  method: 'GET' | 'POST';
  accountId: string | null;
  hasCookie: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
};
type NewSource = Omit<StatsSourceInfo, 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastStatus'> & {
  secret: string;
};

/** Saved page requests. The request itself (URL with its signature, headers, cookie) is only ever stored encrypted. */
export interface StatsSourceStore {
  list(owner: string): Promise<StatsSourceInfo[]>;
  find(owner: string, id: string): Promise<(StatsSourceInfo & { secret: string }) | null>;
  create(owner: string, source: NewSource): Promise<void>;
  update(owner: string, id: string, patch: Partial<NewSource>): Promise<boolean>;
  remove(owner: string, id: string): Promise<boolean>;
  recordRun(owner: string, id: string, status: string, at: Date): Promise<void>;
}

const aad = (owner: string, id: string) => Buffer.from(`${owner}\0${id}\0stats-source`);
export function sealSecret(plain: string, key: Buffer, owner: string, id: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(owner, id));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}
export function openSecret(
  box: { ciphertext: Buffer; iv: Buffer; tag: Buffer },
  key: Buffer,
  owner: string,
  id: string,
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, box.iv);
  decipher.setAAD(aad(owner, id));
  decipher.setAuthTag(box.tag);
  return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]).toString('utf8');
}

export async function ensureStatsSourceTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS livehub_stats_sources (
    id UUID PRIMARY KEY,
    owner_id VARCHAR(128) NOT NULL,
    name VARCHAR(80) NOT NULL,
    account_id UUID REFERENCES livehub_account_imports(id) ON DELETE SET NULL,
    host VARCHAR(200) NOT NULL,
    path VARCHAR(500) NOT NULL,
    method VARCHAR(4) NOT NULL,
    has_cookie BOOLEAN NOT NULL,
    ciphertext BYTEA NOT NULL, iv BYTEA NOT NULL, tag BYTEA NOT NULL,
    last_run_at TIMESTAMPTZ, last_status VARCHAR(40),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS livehub_stats_sources_owner_idx ON livehub_stats_sources(owner_id, created_at)',
  );
}

type Row = {
  id: string;
  name: string;
  account_id: string | null;
  host: string;
  path: string;
  method: 'GET' | 'POST';
  has_cookie: boolean;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  last_status: string | null;
};
const info = (r: Row): StatsSourceInfo => ({
  id: r.id,
  name: r.name,
  host: r.host,
  path: r.path,
  method: r.method,
  accountId: r.account_id,
  hasCookie: r.has_cookie,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : null,
  lastStatus: r.last_status,
});
const publicColumns =
  'id,name,account_id,host,path,method,has_cookie,created_at,updated_at,last_run_at,last_status';

export function createPgStatsSourceStore(pool: Pool, key: Buffer): StatsSourceStore {
  if (key.length !== 32) throw new Error('Stats source encryption key must be 32 bytes.');
  return {
    async list(owner) {
      const r = await pool.query<Row>(
        `SELECT ${publicColumns} FROM livehub_stats_sources WHERE owner_id=$1 ORDER BY created_at, id LIMIT 100`,
        [owner],
      );
      return r.rows.map(info);
    },
    async find(owner, id) {
      const r = await pool.query<Row & { ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
        'SELECT * FROM livehub_stats_sources WHERE owner_id=$1 AND id=$2',
        [owner, id],
      );
      const row = r.rows[0];
      return row ? { ...info(row), secret: openSecret(row, key, owner, id) } : null;
    },
    async create(owner, s) {
      const box = sealSecret(s.secret, key, owner, s.id);
      await pool.query(
        `INSERT INTO livehub_stats_sources(id,owner_id,name,account_id,host,path,method,has_cookie,ciphertext,iv,tag)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          s.id,
          owner,
          s.name,
          s.accountId,
          s.host,
          s.path,
          s.method,
          s.hasCookie,
          box.ciphertext,
          box.iv,
          box.tag,
        ],
      );
    },
    async update(owner, id, p) {
      const sets: string[] = ['updated_at=NOW()'];
      const values: unknown[] = [owner, id];
      const add = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column}=$${values.length}`);
      };
      if (p.name !== undefined) add('name', p.name);
      if (p.accountId !== undefined) add('account_id', p.accountId);
      if (p.host !== undefined) add('host', p.host);
      if (p.path !== undefined) add('path', p.path);
      if (p.method !== undefined) add('method', p.method);
      if (p.hasCookie !== undefined) add('has_cookie', p.hasCookie);
      if (p.secret !== undefined) {
        const box = sealSecret(p.secret, key, owner, id);
        add('ciphertext', box.ciphertext);
        add('iv', box.iv);
        add('tag', box.tag);
      }
      const r = await pool.query(
        `UPDATE livehub_stats_sources SET ${sets.join(',')} WHERE owner_id=$1 AND id=$2`,
        values,
      );
      return r.rowCount === 1;
    },
    async remove(owner, id) {
      const r = await pool.query('DELETE FROM livehub_stats_sources WHERE owner_id=$1 AND id=$2', [
        owner,
        id,
      ]);
      return r.rowCount === 1;
    },
    async recordRun(owner, id, status, at) {
      await pool.query(
        'UPDATE livehub_stats_sources SET last_run_at=$3,last_status=$4 WHERE owner_id=$1 AND id=$2',
        [owner, id, at, status],
      );
    },
  };
}

export function createMemoryStatsSourceStore(): StatsSourceStore {
  const rows = new Map<string, { owner: string; info: StatsSourceInfo; secret: string }>();
  return {
    async list(owner) {
      return [...rows.values()].filter((r) => r.owner === owner).map((r) => ({ ...r.info }));
    },
    async find(owner, id) {
      const r = rows.get(id);
      return r && r.owner === owner ? { ...r.info, secret: r.secret } : null;
    },
    async create(owner, s) {
      const now = new Date().toISOString();
      const { secret, ...rest } = s;
      rows.set(s.id, {
        owner,
        secret,
        info: { ...rest, createdAt: now, updatedAt: now, lastRunAt: null, lastStatus: null },
      });
    },
    async update(owner, id, p) {
      const r = rows.get(id);
      if (!r || r.owner !== owner) return false;
      const { secret, ...rest } = p;
      if (secret !== undefined) r.secret = secret;
      r.info = { ...r.info, ...rest, updatedAt: new Date().toISOString() };
      return true;
    },
    async remove(owner, id) {
      const r = rows.get(id);
      if (!r || r.owner !== owner) return false;
      rows.delete(id);
      return true;
    },
    async recordRun(owner, id, status, at) {
      const r = rows.get(id);
      if (r && r.owner === owner)
        r.info = { ...r.info, lastStatus: status, lastRunAt: at.toISOString() };
    },
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SOURCES = 50;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EXPIRED_HINT =
  'session หรือลายเซ็นของคำขอหมดอายุ ให้คัดลอก cURL ใหม่จากหน้าเดิมแล้วกด "วาง cURL ใหม่"';

export type StatsRunResult = {
  ok: boolean;
  status: number;
  fetchedAt: string;
  data?: unknown;
  error?: string;
  hint?: string;
};
export type StatsFetcher = (url: string, init: RequestInit) => Promise<Response>;

export class StatsSourceService {
  private recent = new Map<string, number[]>();
  constructor(
    private store: StatsSourceStore,
    private deps: {
      /** The account's current decrypted cookie, or null when it has none. */
      cookieFor: (owner: string, accountId: string) => Promise<string | null>;
      accountExists: (owner: string, accountId: string) => Promise<boolean>;
      fetcher?: StatsFetcher;
      now?: () => number;
    },
  ) {}

  private parse(curl: unknown): ParsedStatsCurl {
    if (typeof curl !== 'string' || !curl.trim() || curl.length > 100_000)
      throw new StatsSourceError('วางคำสั่ง cURL ของหน้าสถิติก่อน');
    try {
      return parseStatsCurl(curl);
    } catch {
      throw new StatsSourceError(
        'cURL ไม่ถูกต้องหรือไม่ใช่หน้าของ TikTok คัดลอกด้วย "Copy as cURL (bash)" ทั้งคำสั่ง',
      );
    }
  }
  private cleanName(name: unknown): string {
    // eslint-disable-next-line no-control-regex
    const text = typeof name === 'string' ? name.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
    if (!text || text.length > 80) throw new StatsSourceError('ตั้งชื่อแหล่งข้อมูล 1–80 ตัวอักษร');
    return text;
  }
  private async cleanAccount(owner: string, accountId: unknown): Promise<string | null> {
    if (accountId === undefined || accountId === null || accountId === '') return null;
    if (typeof accountId !== 'string' || !uuid.test(accountId))
      throw new StatsSourceError('บัญชีไม่ถูกต้อง');
    if (!(await this.deps.accountExists(owner, accountId)))
      throw new StatsSourceError('ไม่พบบัญชีนี้', 404);
    return accountId;
  }

  list(owner: string) {
    return this.store.list(owner);
  }

  async create(owner: string, input: { name?: unknown; curl?: unknown; accountId?: unknown }) {
    if ((await this.store.list(owner)).length >= MAX_SOURCES)
      throw new StatsSourceError(`เพิ่มได้ไม่เกิน ${MAX_SOURCES} แหล่งข้อมูล`, 409);
    const name = this.cleanName(input.name);
    const accountId = await this.cleanAccount(owner, input.accountId);
    const parsed = this.parse(input.curl);
    const id = randomUUID();
    await this.store.create(owner, {
      id,
      name,
      accountId,
      host: parsed.host,
      path: parsed.path.slice(0, 500),
      method: parsed.method,
      hasCookie: !!parsed.cookieHeader,
      secret: JSON.stringify(parsed),
    });
    return (await this.store.list(owner)).find((s) => s.id === id)!;
  }

  /** Rename, relink to an account, or paste a fresh cURL when the old one expired. */
  async update(
    owner: string,
    id: string,
    input: { name?: unknown; curl?: unknown; accountId?: unknown },
  ) {
    if (!uuid.test(id)) throw new StatsSourceError('แหล่งข้อมูลไม่ถูกต้อง');
    if (input.name === undefined && input.curl === undefined && input.accountId === undefined)
      throw new StatsSourceError('ไม่มีสิ่งที่ต้องแก้');
    const patch: Parameters<StatsSourceStore['update']>[2] = {};
    if (input.name !== undefined) patch.name = this.cleanName(input.name);
    if (input.accountId !== undefined)
      patch.accountId = await this.cleanAccount(owner, input.accountId);
    if (input.curl !== undefined) {
      const parsed = this.parse(input.curl);
      Object.assign(patch, {
        host: parsed.host,
        path: parsed.path.slice(0, 500),
        method: parsed.method,
        hasCookie: !!parsed.cookieHeader,
        secret: JSON.stringify(parsed),
      });
    }
    if (!(await this.store.update(owner, id, patch)))
      throw new StatsSourceError('ไม่พบแหล่งข้อมูลนี้', 404);
    return (await this.store.list(owner)).find((s) => s.id === id)!;
  }

  async remove(owner: string, id: string) {
    if (!uuid.test(id) || !(await this.store.remove(owner, id)))
      throw new StatsSourceError('ไม่พบแหล่งข้อมูลนี้', 404);
  }

  private limit(owner: string) {
    const t = (this.deps.now ?? Date.now)();
    const list = (this.recent.get(owner) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= 30) throw new StatsSourceError('ดึงข้อมูลถี่เกินไป รอสักครู่', 429);
    list.push(t);
    this.recent.set(owner, list);
  }

  /** Replays the saved request with the account's own session. The request itself is never returned. */
  async run(owner: string, id: string): Promise<StatsRunResult> {
    if (!uuid.test(id)) throw new StatsSourceError('แหล่งข้อมูลไม่ถูกต้อง');
    this.limit(owner);
    const found = await this.store.find(owner, id);
    if (!found) throw new StatsSourceError('ไม่พบแหล่งข้อมูลนี้', 404);
    const request = JSON.parse(found.secret) as ParsedStatsCurl;
    // The linked account's current session wins, so a renewed session keeps working; the copied cookie is the fallback.
    const accountCookie = found.accountId
      ? await this.deps.cookieFor(owner, found.accountId)
      : null;
    const cookie = accountCookie ?? request.cookieHeader;
    const now = new Date((this.deps.now ?? Date.now)());
    const finish = async (
      result: Omit<StatsRunResult, 'fetchedAt'>,
      label: string,
    ): Promise<StatsRunResult> => {
      await this.store.recordRun(owner, id, label, now);
      return { ...result, fetchedAt: now.toISOString() };
    };
    if (!cookie)
      return finish(
        {
          ok: false,
          status: 0,
          error: 'ไม่มี session สำหรับคำขอนี้',
          hint: 'เลือกบัญชีที่เชื่อมไว้ หรือคัดลอก cURL ที่มี cookie',
        },
        'no-session',
      );
    let response: Response;
    try {
      const origin = new URL(request.url).origin;
      response = await (this.deps.fetcher ?? ((u, i) => fetch(u, i)))(request.url, {
        method: request.method,
        headers: {
          accept: 'application/json, text/plain, */*',
          ...request.headers,
          cookie,
          ...(request.method === 'POST' && !request.headers['content-type']
            ? { 'content-type': 'application/json' }
            : {}),
          ...(request.method === 'POST' ? { origin } : {}),
          ...(request.userAgent ? { 'user-agent': request.userAgent } : {}),
          ...(request.referer ? { referer: request.referer } : {}),
        },
        body: request.method === 'POST' ? request.body : undefined,
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return finish({ ok: false, status: 0, error: 'เชื่อมต่อ TikTok ไม่ได้' }, 'network');
    }
    if (response.status >= 300 && response.status < 400)
      return finish(
        { ok: false, status: response.status, error: 'TikTok ส่งไปหน้าอื่น', hint: EXPIRED_HINT },
        `http ${response.status}`,
      );
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)
      return finish(
        { ok: false, status: response.status, error: 'ผลลัพธ์ใหญ่เกินไป' },
        'too-large',
      );
    const text = await response.text().catch(() => '');
    if (text.length > MAX_RESPONSE_BYTES)
      return finish(
        { ok: false, status: response.status, error: 'ผลลัพธ์ใหญ่เกินไป' },
        'too-large',
      );
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return finish(
        {
          ok: false,
          status: response.status,
          error: 'TikTok ไม่ได้ตอบเป็นข้อมูล JSON',
          hint: EXPIRED_HINT,
        },
        response.ok ? 'not-json' : `http ${response.status}`,
      );
    }
    const obj =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    const code = obj.code ?? obj.status_code;
    const failed = !response.ok || (code !== undefined && code !== 0 && code !== '0');
    if (failed) {
      const message =
        typeof (obj.message ?? obj.msg) === 'string'
          ? String(obj.message ?? obj.msg).slice(0, 200)
          : '';
      return finish(
        {
          ok: false,
          status: response.status,
          error: `TikTok ปฏิเสธคำขอ${typeof code === 'number' || typeof code === 'string' ? ` (รหัส ${String(code).slice(0, 12)})` : ''}${message ? `: ${message}` : ''}`,
          hint: EXPIRED_HINT,
        },
        !response.ok ? `http ${response.status}` : `code ${String(code).slice(0, 12)}`,
      );
    }
    return finish({ ok: true, status: response.status, data }, 'ok');
  }
}
