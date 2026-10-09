import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface ProductSetItem {
  id: string;
  name: string;
  accountId: string | null;
  roomId: string;
  productIds: string[];
  hasCookie: boolean;
  hasDelete: boolean;
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
  /** undefined keeps the saved remove request, null clears it. */
  deleteCurl?: string | null;
}

export interface ProductSetStore {
  list(ownerId: string): Promise<ProductSetItem[]>;
  find(
    ownerId: string,
    id: string,
  ): Promise<(ProductSetItem & { curl: string; deleteCurl: string | null }) | null>;
  create(ownerId: string, input: ProductSetInput): Promise<ProductSetItem>;
  update(ownerId: string, id: string, input: ProductSetInput): Promise<ProductSetItem | null>;
  delete(ownerId: string, id: string): Promise<boolean>;
  selectForLive(ownerId: string, id: string): Promise<void>;
  /** Turn the automatic add at LIVE start on or off for one set (one set per account can be on). */
  setAutoApply(
    ownerId: string,
    id: string,
    enabled: boolean,
  ): Promise<'ok' | 'not-found' | 'no-account'>;
}

type Row = {
  has_delete?: boolean;
  delete_curl_ciphertext: Buffer | null;
  delete_curl_iv: Buffer | null;
  delete_curl_tag: Buffer | null;
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

const publicColumns =
  'id, name, account_id, room_id, product_ids, has_cookie, auto_apply, created_at, updated_at, (delete_curl_ciphertext IS NOT NULL) AS has_delete';

function item(row: Row): ProductSetItem {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    roomId: row.room_id,
    productIds: row.product_ids,
    hasCookie: row.has_cookie,
    hasDelete: row.has_delete ?? row.delete_curl_ciphertext != null,
    autoApply: row.auto_apply,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function encrypt(curl: string, key: Buffer, ownerId: string, id: string, purpose = 'product-set') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${ownerId}\0${id}\0${purpose}`, 'utf8'));
  const plaintext = Buffer.from(curl, 'utf8');
  try {
    return {
      ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
      iv,
      tag: cipher.getAuthTag(),
    };
  } finally {
    plaintext.fill(0);
  }
}

function decrypt(row: Row, key: Buffer, remove = false): string {
  const iv = remove ? row.delete_curl_iv : row.curl_iv;
  const tag = remove ? row.delete_curl_tag : row.curl_tag;
  const ciphertext = remove ? row.delete_curl_ciphertext : row.curl_ciphertext;
  if (!iv || !tag || !ciphertext) throw new Error('Saved request is missing.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(
    Buffer.from(
      `${row.owner_id}\0${row.id}\0${remove ? 'product-set-delete' : 'product-set'}`,
      'utf8',
    ),
  );
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
  await pool.query(
    'ALTER TABLE livehub_product_sets ADD COLUMN IF NOT EXISTS auto_apply BOOLEAN NOT NULL DEFAULT FALSE',
  );
  await pool.query(`
    ALTER TABLE livehub_product_sets
      ADD COLUMN IF NOT EXISTS delete_curl_ciphertext BYTEA,
      ADD COLUMN IF NOT EXISTS delete_curl_iv BYTEA,
      ADD COLUMN IF NOT EXISTS delete_curl_tag BYTEA
  `);
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
      return row
        ? {
            ...item(row),
            curl: decrypt(row, key),
            deleteCurl: row.delete_curl_ciphertext ? decrypt(row, key, true) : null,
          }
        : null;
    },
    async create(ownerId, input) {
      const id = randomUUID();
      const secret = encrypt(input.curl, key, ownerId, id);
      const removal = input.deleteCurl
        ? encrypt(input.deleteCurl, key, ownerId, id, 'product-set-delete')
        : null;
      const result = await pool.query<Row>(
        `INSERT INTO livehub_product_sets
         (id, owner_id, name, account_id, room_id, product_ids, has_cookie,
          curl_ciphertext, curl_iv, curl_tag,
          delete_curl_ciphertext, delete_curl_iv, delete_curl_tag)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)
         RETURNING ${publicColumns}`,
        [
          id,
          ownerId,
          input.name,
          input.accountId,
          input.roomId,
          JSON.stringify(input.productIds),
          input.hasCookie,
          secret.ciphertext,
          secret.iv,
          secret.tag,
          removal?.ciphertext ?? null,
          removal?.iv ?? null,
          removal?.tag ?? null,
        ],
      );
      return item(result.rows[0]);
    },
    async update(ownerId, id, input) {
      const secret = encrypt(input.curl, key, ownerId, id);
      const removal = input.deleteCurl
        ? encrypt(input.deleteCurl, key, ownerId, id, 'product-set-delete')
        : null;
      const result = await pool.query<Row>(
        `UPDATE livehub_product_sets SET
           name = $3, account_id = $4, room_id = $5, product_ids = $6::jsonb,
           has_cookie = $7, curl_ciphertext = $8, curl_iv = $9, curl_tag = $10,
           delete_curl_ciphertext = CASE WHEN $11::boolean THEN $12::bytea ELSE delete_curl_ciphertext END,
           delete_curl_iv = CASE WHEN $11::boolean THEN $13::bytea ELSE delete_curl_iv END,
           delete_curl_tag = CASE WHEN $11::boolean THEN $14::bytea ELSE delete_curl_tag END,
           auto_apply = CASE WHEN account_id IS DISTINCT FROM $4 THEN FALSE ELSE auto_apply END,
           updated_at = NOW()
         WHERE owner_id = $1 AND id = $2
         RETURNING ${publicColumns}`,
        [
          ownerId,
          id,
          input.name,
          input.accountId,
          input.roomId,
          JSON.stringify(input.productIds),
          input.hasCookie,
          secret.ciphertext,
          secret.iv,
          secret.tag,
          input.deleteCurl !== undefined,
          removal?.ciphertext ?? null,
          removal?.iv ?? null,
          removal?.tag ?? null,
        ],
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
    async setAutoApply(ownerId, id, enabled) {
      const found = await pool.query<{ account_id: string | null }>(
        'SELECT account_id FROM livehub_product_sets WHERE owner_id = $1 AND id = $2',
        [ownerId, id],
      );
      const row = found.rows[0];
      if (!row) return 'not-found';
      if (!enabled) {
        await pool.query(
          'UPDATE livehub_product_sets SET auto_apply = FALSE WHERE owner_id = $1 AND id = $2',
          [ownerId, id],
        );
        return 'ok';
      }
      if (!row.account_id) return 'no-account';
      await pool.query(
        'UPDATE livehub_product_sets SET auto_apply = (id = $2) WHERE owner_id = $1 AND account_id = $3',
        [ownerId, id, row.account_id],
      );
      return 'ok';
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
