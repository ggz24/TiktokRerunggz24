import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Pool } from 'pg';
const require = createRequire(import.meta.url);
const { parseLiveProductPinCurl } =
  require('@live-hub/tiktok-client') as typeof import('@live-hub/tiktok-client');
export async function ensureProductPinTable(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS livehub_product_pin_requests (
    owner_id VARCHAR(128) NOT NULL, account_id UUID NOT NULL REFERENCES livehub_account_imports(id) ON DELETE CASCADE,
    secret JSONB NOT NULL, PRIMARY KEY(owner_id,account_id))`);
}
export class ProductPinStore {
  constructor(
    private pool: Pool,
    private key: Buffer,
  ) {
    if (key.length !== 32) throw Error('Invalid encryption key.');
  }
  private aad(owner: string, account: string) {
    return Buffer.from(`${owner}\0${account}\0product-pin`);
  }
  async has(owner: string, account: string) {
    const r = await this.pool.query(
      'SELECT 1 FROM livehub_product_pin_requests WHERE owner_id=$1 AND account_id=$2',
      [owner, account],
    );
    return r.rows.length > 0;
  }
  async save(owner: string, account: string, curl: string | null) {
    if (curl === null) {
      await this.pool.query(
        'DELETE FROM livehub_product_pin_requests WHERE owner_id=$1 AND account_id=$2',
        [owner, account],
      );
      return;
    }
    parseLiveProductPinCurl(curl);
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(owner, account));
    const bytes = Buffer.concat([cipher.update(curl, 'utf8'), cipher.final()]);
    const secret = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: bytes.toString('base64'),
    };
    await this.pool.query(
      'INSERT INTO livehub_product_pin_requests(owner_id,account_id,secret) VALUES($1,$2,$3::jsonb) ON CONFLICT(owner_id,account_id) DO UPDATE SET secret=EXCLUDED.secret',
      [owner, account, JSON.stringify(secret)],
    );
  }
  async load(owner: string, account: string): Promise<string | null> {
    const r = await this.pool.query(
      'SELECT secret FROM livehub_product_pin_requests WHERE owner_id=$1 AND account_id=$2',
      [owner, account],
    );
    const s = r.rows[0]?.secret;
    if (!s) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(s.iv, 'base64'));
    decipher.setAAD(this.aad(owner, account));
    decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(s.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
