import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface ProductSetItem {
  id: string;
  name: string;
  accountId: string | null;
  roomId: string;
  productIds: string[];
  hasCookie: boolean;
  autoApply: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSetInput {
  name: string;
  accountId: string | null;
  roomId: string;
  productIds: string[];
  hasCookie: boolean;
  curl: string;
}

export interface ProductSetStore {
  list(ownerId: string): Promise<ProductSetItem[]>;
  find(ownerId: string, id: string): Promise<(ProductSetItem & { curl: string }) | null>;
  create(ownerId: string, input: ProductSetInput): Promise<ProductSetItem>;
  update(ownerId: string, id: string, input: ProductSetInput): Promise<ProductSetItem | null>;
  delete(ownerId: string, id: string): Promise<boolean>;
  selectForLive(ownerId: string, id: string): Promise<void>;
}

type Row = {
  id: string;
  owner_id: string;
  name: string;
  account_id: string | null;
  room_id: string;
  product_ids: string[];
  has_cookie: boolean;
  auto_apply: boolean;
  curl_ciphertext: Buffer;
  curl_iv: Buffer;
  curl_tag: Buffer;
  created_at: Date | string;
  updated_at: Date | string;
};

const publicColumns = 'id, name, account_id, room_id, product_ids, has_cookie, auto_apply, created_at, updated_at';

function item(row: Row): ProductSetItem {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    roomId: row.room_id,
    productIds: row.product_ids,
    hasCookie: row.has_cookie,
    autoApply: row.auto_apply,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function encrypt(curl: string, key: Buffer, ownerId: string, id: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${ownerId}\0${id}\0product-set`, 'utf8'));
  const plaintext = Buffer.from(curl, 'utf8');
  try {
    return { ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]), iv, tag: cipher.getAuthTag() };
  } finally {
    plaintext.fill(0);
  }
}

function decrypt(row: Row, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, row.curl_iv);
  decipher.setAAD(Buffer.from(`${row.owner_id}\0${row.id}\0product-set`, 'utf8'));
  decipher.setAuthTag(row.curl_tag);
  const plaintext = Buffer.concat([decipher.update(row.curl_ciphertext), decipher.final()]);
  try {
    return plaintext.toString('utf8');
  } finally {
    plaintext.fill(0);
  }
}

export async function ensureProductSetTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS livehub_product_sets (
      id UUID PRIMARY KEY,
      owner_id VARCHAR(128) NOT NULL,
      name VARCHAR(80) NOT NULL,
      account_id UUID REFERENCES livehub_account_imports(id) ON DELETE SET NULL,
      room_id VARCHAR(24) NOT NULL,
      product_ids JSONB NOT NULL,
      has_cookie BOOLEAN NOT NULL,
      auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
      curl_ciphertext BYTEA NOT NULL,
      curl_iv BYTEA NOT NULL,
      curl_tag BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE livehub_product_sets ADD COLUMN IF NOT EXISTS auto_apply BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS livehub_product_sets_owner_updated_idx
    ON livehub_product_sets (owner_id, updated_at DESC)
  `);
}

export function createPgProductSetStore(pool: Pool, key: Buffer): ProductSetStore {
  if (key.length !== 32) throw new Error('Product set encryption key must be 32 bytes.');
  return {
    async list(ownerId) {
      const result = await pool.query<Row>(
        `SELECT ${publicColumns} FROM livehub_product_sets
         WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 200`,
        [ownerId],
      );
      return result.rows.map(item);
    },
    async find(ownerId, id) {
      const result = await pool.query<Row>(
        'SELECT * FROM livehub_product_sets WHERE owner_id = $1 AND id = $2',
        [ownerId, id],
      );
      const row = result.rows[0];
      return row ? { ...item(row), curl: decrypt(row, key) } : null;
    },
    async create(ownerId, input) {
      const id = randomUUID();
      const secret = encrypt(input.curl, key, ownerId, id);
      const result = await pool.query<Row>(
        `INSERT INTO livehub_product_sets
         (id, owner_id, name, account_id, room_id, product_ids, has_cookie,
          curl_ciphertext, curl_iv, curl_tag)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
         RETURNING ${publicColumns}`,
        [id, ownerId, input.name, input.accountId, input.roomId,
          JSON.stringify(input.productIds), input.hasCookie,
          secret.ciphertext, secret.iv, secret.tag],
      );
      return item(result.rows[0]);
    },
    async update(ownerId, id, input) {
      const secret = encrypt(input.curl, key, ownerId, id);
      const result = await pool.query<Row>(
        `UPDATE livehub_product_sets SET
           name = $3, account_id = $4, room_id = $5, product_ids = $6::jsonb,
           has_cookie = $7, curl_ciphertext = $8, curl_iv = $9, curl_tag = $10,
           auto_apply = CASE WHEN account_id IS DISTINCT FROM $4 THEN FALSE ELSE auto_apply END,
           updated_at = NOW()
         WHERE owner_id = $1 AND id = $2
         RETURNING ${publicColumns}`,
        [ownerId, id, input.name, input.accountId, input.roomId,
          JSON.stringify(input.productIds), input.hasCookie,
          secret.ciphertext, secret.iv, secret.tag],
      );
      return result.rows[0] ? item(result.rows[0]) : null;
    },
    async delete(ownerId, id) {
      const result = await pool.query<{ id: string }>(
        'DELETE FROM livehub_product_sets WHERE owner_id = $1 AND id = $2 RETURNING id',
        [ownerId, id],
      );
      return result.rows.length > 0;
    },
    async selectForLive(ownerId, id) {
      await pool.query(
        `UPDATE livehub_product_sets SET auto_apply = (id = $2)
         WHERE owner_id = $1 AND account_id = (
           SELECT account_id FROM livehub_product_sets WHERE owner_id = $1 AND id = $2
         )`,
        [ownerId, id],
      );
    },
  };
}
