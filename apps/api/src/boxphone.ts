import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool } from 'pg';
import {
  BoxphoneInputError,
  applySettingsPatch,
  createPlan,
  createQuestions,
  defaultSettings,
  publicSettings,
  resolveKeys,
  transcribeAudio,
  PLAN_MODEL,
  type BoxphoneSettings,
  type Fetcher,
  type PublicBoxphoneSettings,
} from './boxphone-ai.js';

export type BoxphoneAgentRecord = { id: string; owner: string; name: string; tokenHash: string };
export type BoxphoneAgentInfo = {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string | null;
};

/** Persistence for the owner's AI keys (encrypted) and the computers paired to run phones. */
export interface BoxphoneStore {
  loadSettings(owner: string): Promise<BoxphoneSettings>;
  saveSettings(owner: string, settings: BoxphoneSettings): Promise<void>;
  clearSettings(owner: string): Promise<void>;
  createPairing(owner: string, codeHash: string, expiresAt: Date): Promise<void>;
  checkPairing(codeHash: string, now: Date): Promise<boolean>;
  /** Marks the code used and returns its owner, or null when unknown, used or expired. */
  redeemPairing(codeHash: string, now: Date): Promise<string | null>;
  createAgent(agent: BoxphoneAgentRecord): Promise<void>;
  findAgent(id: string): Promise<BoxphoneAgentRecord | null>;
  touchAgent(id: string, now: Date): Promise<void>;
  listAgents(owner: string): Promise<BoxphoneAgentInfo[]>;
  deleteAgent(owner: string, id: string): Promise<boolean>;
}

const AAD = (owner: string) => Buffer.from(`boxphone-ai-keys\0${owner}`);

export function sealSettings(settings: BoxphoneSettings, key: Buffer, owner: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD(owner));
  const data = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('base64'),
  });
}

export function openSettings(raw: string, key: Buffer, owner: string): BoxphoneSettings {
  try {
    const box = JSON.parse(raw) as { v: number; iv: string; tag: string; data: string };
    if (box.v !== 1) throw new Error('version');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex'));
    decipher.setAAD(AAD(owner));
    decipher.setAuthTag(Buffer.from(box.tag, 'hex'));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString(
        'utf8',
      ),
    );
    return applySettingsPatch(defaultSettings(), payload);
  } catch {
    throw new BoxphoneInputError('ถอดรหัสคีย์ที่บันทึกไว้ไม่ได้ ตรวจค่าการเข้ารหัสของระบบ', 500);
  }
}

export async function ensureBoxphoneTables(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS livehub_boxphone_settings (
    owner_id TEXT PRIMARY KEY, secret TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS livehub_boxphone_agents (
    id UUID PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ)`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS livehub_boxphone_agents_owner ON livehub_boxphone_agents(owner_id)`,
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS livehub_boxphone_pairings (
    code_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN NOT NULL DEFAULT FALSE)`);
}

export function createPgBoxphoneStore(pool: Pool, encryptionKey: Buffer): BoxphoneStore {
  return {
    async loadSettings(owner) {
      const r = await pool.query<{ secret: string }>(
        'SELECT secret FROM livehub_boxphone_settings WHERE owner_id=$1',
        [owner],
      );
      return r.rows[0] ? openSettings(r.rows[0].secret, encryptionKey, owner) : defaultSettings();
    },
    async saveSettings(owner, settings) {
      await pool.query(
        `INSERT INTO livehub_boxphone_settings(owner_id,secret) VALUES($1,$2)
         ON CONFLICT(owner_id) DO UPDATE SET secret=EXCLUDED.secret, updated_at=NOW()`,
        [owner, sealSettings(settings, encryptionKey, owner)],
      );
    },
    async clearSettings(owner) {
      await pool.query('DELETE FROM livehub_boxphone_settings WHERE owner_id=$1', [owner]);
    },
    async createPairing(owner, codeHash, expiresAt) {
      await pool.query(
        "DELETE FROM livehub_boxphone_pairings WHERE expires_at < NOW() - INTERVAL '1 day'",
      );
      await pool.query(
        'INSERT INTO livehub_boxphone_pairings(code_hash,owner_id,expires_at) VALUES($1,$2,$3)',
        [codeHash, owner, expiresAt],
      );
    },
    async checkPairing(codeHash, now) {
      const r = await pool.query(
        'SELECT 1 FROM livehub_boxphone_pairings WHERE code_hash=$1 AND NOT used AND expires_at > $2',
        [codeHash, now],
      );
      return r.rowCount === 1;
    },
    async redeemPairing(codeHash, now) {
      const r = await pool.query<{ owner_id: string }>(
        'UPDATE livehub_boxphone_pairings SET used=TRUE WHERE code_hash=$1 AND NOT used AND expires_at > $2 RETURNING owner_id',
        [codeHash, now],
      );
      return r.rows[0]?.owner_id ?? null;
    },
    async createAgent(agent) {
      await pool.query(
        'INSERT INTO livehub_boxphone_agents(id,owner_id,name,token_hash) VALUES($1,$2,$3,$4)',
        [agent.id, agent.owner, agent.name, agent.tokenHash],
      );
    },
    async findAgent(id) {
      const r = await pool.query<{
        id: string;
        owner_id: string;
        name: string;
        token_hash: string;
      }>('SELECT id,owner_id,name,token_hash FROM livehub_boxphone_agents WHERE id=$1', [id]);
      const row = r.rows[0];
      return row
        ? { id: row.id, owner: row.owner_id, name: row.name, tokenHash: row.token_hash }
        : null;
    },
    async touchAgent(id, now) {
      await pool.query('UPDATE livehub_boxphone_agents SET last_seen=$2 WHERE id=$1', [id, now]);
    },
    async listAgents(owner) {
      const r = await pool.query<{
        id: string;
        name: string;
        created_at: Date;
        last_seen: Date | null;
      }>(
        'SELECT id,name,created_at,last_seen FROM livehub_boxphone_agents WHERE owner_id=$1 ORDER BY created_at',
        [owner],
      );
      return r.rows.map((x) => ({
        id: x.id,
        name: x.name,
        createdAt: x.created_at.toISOString(),
        lastSeen: x.last_seen ? x.last_seen.toISOString() : null,
      }));
    },
    async deleteAgent(owner, id) {
      const r = await pool.query(
        'DELETE FROM livehub_boxphone_agents WHERE id=$1 AND owner_id=$2',
        [id, owner],
      );
      return r.rowCount === 1;
    },
  };
}

export function createMemoryBoxphoneStore(): BoxphoneStore {
  const settings = new Map<string, BoxphoneSettings>();
  const pairings = new Map<string, { owner: string; expiresAt: Date; used: boolean }>();
  const agents = new Map<
    string,
    BoxphoneAgentRecord & { createdAt: Date; lastSeen: Date | null }
  >();
  return {
    async loadSettings(owner) {
      return structuredClone(settings.get(owner) ?? defaultSettings());
    },
    async saveSettings(owner, value) {
      settings.set(owner, structuredClone(value));
    },
    async clearSettings(owner) {
      settings.delete(owner);
    },
    async createPairing(owner, codeHash, expiresAt) {
      pairings.set(codeHash, { owner, expiresAt, used: false });
    },
    async checkPairing(codeHash, now) {
      const p = pairings.get(codeHash);
      return !!p && !p.used && p.expiresAt > now;
    },
    async redeemPairing(codeHash, now) {
      const p = pairings.get(codeHash);
      if (!p || p.used || p.expiresAt <= now) return null;
      p.used = true;
      return p.owner;
    },
    async createAgent(agent) {
      agents.set(agent.id, { ...agent, createdAt: new Date(), lastSeen: null });
    },
    async findAgent(id) {
      const a = agents.get(id);
      return a ? { id: a.id, owner: a.owner, name: a.name, tokenHash: a.tokenHash } : null;
    },
    async touchAgent(id, now) {
      const a = agents.get(id);
      if (a) a.lastSeen = now;
    },
    async listAgents(owner) {
      return [...agents.values()]
        .filter((a) => a.owner === owner)
        .map((a) => ({
          id: a.id,
          name: a.name,
          createdAt: a.createdAt.toISOString(),
          lastSeen: a.lastSeen ? a.lastSeen.toISOString() : null,
        }));
    },
    async deleteAgent(owner, id) {
      const a = agents.get(id);
      if (!a || a.owner !== owner) return false;
      agents.delete(id);
      return true;
    },
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const PAIRING_TTL_MS = 10 * 60 * 1000;

export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${CODE_ALPHABET}]{8}$`).test(code) ? code : null;
}

export class BoxphoneService {
  private locks = new Map<string, Promise<unknown>>();
  private failures: number[] = [];
  private touched = new Map<string, number>();

  constructor(
    private store: BoxphoneStore,
    private fetcher: Fetcher = (url, init) => fetch(url, init),
    private defaultOpenAiKey = '',
    private now: () => number = () => Date.now(),
  ) {}

  private locked<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(owner) ?? Promise.resolve();
    const job = prior.catch(() => undefined).then(work);
    this.locks.set(owner, job);
    return job.finally(() => {
      if (this.locks.get(owner) === job) this.locks.delete(owner);
    });
  }

  /** Keys typed or saved come first; an optional server wide key is only a last resort. */
  private withDefault(keys: string[]): string[] {
    return this.defaultOpenAiKey ? [...new Set([...keys, this.defaultOpenAiKey])] : keys;
  }

  // ---- AI keys and calls ----
  async settings(owner: string): Promise<PublicBoxphoneSettings> {
    return publicSettings(await this.store.loadSettings(owner));
  }
  saveSettings(owner: string, patch: unknown): Promise<PublicBoxphoneSettings> {
    return this.locked(owner, async () => {
      const next = applySettingsPatch(await this.store.loadSettings(owner), patch);
      await this.store.saveSettings(owner, next);
      return publicSettings(next);
    });
  }
  clearSettings(owner: string): Promise<PublicBoxphoneSettings> {
    return this.locked(owner, async () => {
      await this.store.clearSettings(owner);
      return publicSettings(defaultSettings());
    });
  }

  async transcribe(owner: string, audio: Buffer, name: string, mime: string, inlineKey?: unknown) {
    const keys = this.withDefault(
      resolveKeys(await this.store.loadSettings(owner), 'transcriptionKey', inlineKey),
    );
    return transcribeAudio(this.fetcher, keys, audio, name, mime);
  }

  async questions(owner: string, body: Record<string, unknown>) {
    const transcript = String(body.transcript ?? '').trim();
    if (!transcript || transcript.length > 20000)
      throw new BoxphoneInputError('ใส่บทพูด 1–20,000 ตัวอักษร');
    const count = Math.max(1, Math.min(8, Number(body.count) || 3));
    const settings = await this.store.loadSettings(owner);
    const provider = body.questionProvider === 'openrouter' ? 'openrouter' : 'openai';
    const rawModel = String(body.questionModel || settings.questionModels[provider]).trim();
    const model = /^[A-Za-z0-9._:/-]{1,200}$/.test(rawModel)
      ? rawModel
      : settings.questionModels[provider];
    const keys = resolveKeys(
      settings,
      provider === 'openrouter' ? 'openrouterKey' : 'openaiKey',
      body.questionKey,
    );
    return createQuestions(
      this.fetcher,
      provider,
      provider === 'openai' ? this.withDefault(keys) : keys,
      model,
      {
        transcript,
        style: String(body.style ?? 'สุภาพ กระชับ').slice(0, 1000),
        previous: (Array.isArray(body.previous) ? body.previous : []).map(String).slice(-100),
        count,
      },
    );
  }

  async plan(owner: string, body: Record<string, unknown>) {
    const duration = Number(body.duration);
    if (!Number.isFinite(duration) || duration < 5 || duration > 86400)
      throw new BoxphoneInputError('ความยาวคลิปไม่ถูกต้อง');
    const settings = await this.store.loadSettings(owner);
    const keys = this.withDefault(resolveKeys(settings, 'openaiKey', body.questionKey));
    const models = [body.planModel, body.fallbackModel, PLAN_MODEL]
      .map((m) => String(m ?? '').trim())
      .filter((m) => /^[A-Za-z0-9._:-]{1,100}$/.test(m));
    const chunks = (Array.isArray(body.chunks) ? body.chunks : [])
      .slice(0, 2000)
      .map((c: { start?: unknown; text?: unknown }) => ({
        start: Number(c?.start),
        text: String(c?.text ?? '').slice(0, 4000),
      }));
    return createPlan(this.fetcher, keys, {
      chunks,
      duration,
      count: Number(body.count) || undefined,
      minGap: Number(body.minGap) || undefined,
      style: String(body.style ?? 'สุภาพ กระชับ'),
      previous: (Array.isArray(body.previous) ? body.previous : []).map(String),
      models: models.length ? models : [PLAN_MODEL],
    });
  }

  // ---- computers (agents) ----
  private noteFailure() {
    const t = this.now();
    this.failures = this.failures.filter((x) => t - x < 60_000);
    this.failures.push(t);
  }
  private checkAttempts() {
    const t = this.now();
    this.failures = this.failures.filter((x) => t - x < 60_000);
    if (this.failures.length >= 10)
      throw new BoxphoneInputError('ลองรหัสผิดบ่อยเกินไป รอสักครู่', 429);
  }

  async createPairing(owner: string): Promise<{ code: string; expiresAt: string }> {
    let code = '';
    for (const byte of randomBytes(8)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    const expiresAt = new Date(this.now() + PAIRING_TTL_MS);
    await this.store.createPairing(owner, sha256(code), expiresAt);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /** Whether a code can still be used. Used by the installer before it downloads anything. */
  async checkPairing(rawCode: unknown): Promise<boolean> {
    this.checkAttempts();
    const code = normalizePairingCode(rawCode);
    const ok = !!code && (await this.store.checkPairing(sha256(code), new Date(this.now())));
    if (!ok) this.noteFailure();
    return ok;
  }

  /** Exchanges a one-time code for this computer's own token. The token is shown once and stored hashed. */
  async redeemPairing(
    rawCode: unknown,
    rawName: unknown,
  ): Promise<{ agentId: string; token: string; owner: string; name: string }> {
    this.checkAttempts();
    const code = normalizePairingCode(rawCode);
    // eslint-disable-next-line no-control-regex
    const withoutControls = String(rawName ?? '').replace(/[\x00-\x1f\x7f]/g, '');
    const name = withoutControls.trim().slice(0, 60) || 'คอมพิวเตอร์';
    const owner = code ? await this.store.redeemPairing(sha256(code), new Date(this.now())) : null;
    if (!owner) {
      this.noteFailure();
      throw new BoxphoneInputError('รหัสจับคู่ไม่ถูกต้องหรือหมดอายุ', 403);
    }
    const agentId = randomUUID();
    const secret = randomBytes(32).toString('hex');
    await this.store.createAgent({ id: agentId, owner, name, tokenHash: sha256(secret) });
    return { agentId, token: `${agentId}.${secret}`, owner, name };
  }

  async authenticateAgent(
    bearer: unknown,
  ): Promise<{ id: string; owner: string; name: string } | null> {
    if (typeof bearer !== 'string') return null;
    const match = /^([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(bearer);
    if (!match) return null;
    const agent = await this.store.findAgent(match[1]);
    if (!agent) return null;
    const a = Buffer.from(sha256(match[2]));
    const b = Buffer.from(agent.tokenHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const t = this.now();
    if (t - (this.touched.get(agent.id) ?? 0) > 30_000) {
      this.touched.set(agent.id, t);
      await this.store.touchAgent(agent.id, new Date(t));
    }
    return { id: agent.id, owner: agent.owner, name: agent.name };
  }

  listAgents(owner: string) {
    return this.store.listAgents(owner);
  }
  removeAgent(owner: string, id: string) {
    return this.store.deleteAgent(owner, id);
  }
}
