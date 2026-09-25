import type { Pool } from 'pg';
import type {
  AccountMetadata,
  AccountStore,
  EncryptedAccountSecret,
  StoredAccount,
} from './accounts.js';

type AccountRow = {
  id: string;
  alias: string;
  claimed_handle: string | null;
  verified_username: string | null;
  avatar_url: string | null;
  verified_at: Date | string | null;
  verification_status: 'connected' | 'pending_verification' | 'disconnected';
  probe: 'responded' | 'failed' | 'not_run';
  probe_http_status: number | null;
  created_at: Date | string;
};

const publicColumns =
  'id, alias, claimed_handle, verified_username, avatar_url, verified_at, verification_status, probe, probe_http_status, created_at';

function metadata(row: AccountRow): AccountMetadata {
  return {
    id: row.id,
    alias: row.alias,
    ...(row.claimed_handle === null ? {} : { claimedHandle: row.claimed_handle }),
    ...(row.verified_username === null ? {} : { verifiedHandle: row.verified_username }),
    ...(row.avatar_url === null ? {} : { avatarUrl: row.avatar_url }),
    ...(row.verified_at === null ? {} : { verifiedAt: new Date(row.verified_at).toISOString() }),
    verificationStatus: row.verification_status,
    probe: row.probe,
    probeHttpStatus: row.probe_http_status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Dedicated table until the team integrates its reviewed Prisma schema. */
export async function ensureAccountTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS livehub_account_imports (
      id UUID PRIMARY KEY,
      owner_id VARCHAR(128) NOT NULL,
      alias VARCHAR(80) NOT NULL,
      claimed_handle VARCHAR(32),
      verified_username VARCHAR(32),
      verified_user_id VARCHAR(32),
      avatar_url TEXT,
      verified_at TIMESTAMPTZ,
      verification_status TEXT NOT NULL CHECK (verification_status IN ('connected', 'pending_verification', 'disconnected')),
      probe TEXT NOT NULL CHECK (probe IN ('responded', 'failed', 'not_run')),
      probe_http_status SMALLINT,
      cookie_ciphertext BYTEA NOT NULL,
      cookie_iv BYTEA NOT NULL,
      cookie_tag BYTEA NOT NULL,
      user_agent_ciphertext BYTEA,
      user_agent_iv BYTEA,
      user_agent_tag BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE livehub_account_imports
      ADD COLUMN IF NOT EXISTS verified_username VARCHAR(32),
      ADD COLUMN IF NOT EXISTS verified_user_id VARCHAR(32),
      ADD COLUMN IF NOT EXISTS avatar_url TEXT,
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS user_agent_ciphertext BYTEA,
      ADD COLUMN IF NOT EXISTS user_agent_iv BYTEA,
      ADD COLUMN IF NOT EXISTS user_agent_tag BYTEA
  `);
  await pool.query(`
    ALTER TABLE livehub_account_imports
      DROP CONSTRAINT IF EXISTS livehub_account_imports_verification_status_check;
    ALTER TABLE livehub_account_imports
      ADD CONSTRAINT livehub_account_imports_verification_status_check
      CHECK (verification_status IN ('connected', 'pending_verification', 'disconnected'))
  `);
  await pool.query(`
    UPDATE livehub_account_imports
    SET verified_username = NULL,
        verified_user_id = NULL,
        avatar_url = NULL,
        verified_at = NULL
    WHERE verification_status = 'disconnected'
      AND (verified_username IS NOT NULL OR verified_user_id IS NOT NULL
           OR avatar_url IS NOT NULL OR verified_at IS NOT NULL)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS livehub_account_imports_owner_created_idx
    ON livehub_account_imports (owner_id, created_at DESC)
  `);
}

export function createPgAccountStore(pool: Pool): AccountStore {
  return {
    async list(ownerId) {
      const result = await pool.query<AccountRow>(
        `SELECT ${publicColumns} FROM livehub_account_imports
         WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
        [ownerId],
      );
      return result.rows.map(metadata);
    },
    async insert(account: StoredAccount) {
      const result = await pool.query<AccountRow>(
        `INSERT INTO livehub_account_imports
         (id, owner_id, alias, claimed_handle, verified_username, verified_user_id,
          avatar_url, verified_at, verification_status, probe, probe_http_status,
          cookie_ciphertext, cookie_iv, cookie_tag,
          user_agent_ciphertext, user_agent_iv, user_agent_tag, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING ${publicColumns}`,
        [
          account.id,
          account.ownerId,
          account.alias,
          account.claimedHandle ?? null,
          account.verifiedHandle ?? null,
          account.verifiedUserId ?? null,
          account.avatarUrl ?? null,
          account.verifiedAt ?? null,
          account.verificationStatus,
          account.probe,
          account.probeHttpStatus,
          account.ciphertext,
          account.iv,
          account.tag,
          account.userAgent?.ciphertext ?? null,
          account.userAgent?.iv ?? null,
          account.userAgent?.tag ?? null,
          account.createdAt,
        ],
      );
      return metadata(result.rows[0]);
    },
    async findEncrypted(ownerId, id) {
      const result = await pool.query<
        Pick<AccountRow, 'id' | 'claimed_handle'> & {
          owner_id: string;
          cookie_ciphertext: Buffer;
          cookie_iv: Buffer;
          cookie_tag: Buffer;
          user_agent_ciphertext: Buffer | null;
          user_agent_iv: Buffer | null;
          user_agent_tag: Buffer | null;
        }
      >(
        `SELECT id, owner_id, claimed_handle, cookie_ciphertext, cookie_iv, cookie_tag,
                user_agent_ciphertext, user_agent_iv, user_agent_tag
         FROM livehub_account_imports WHERE owner_id = $1 AND id = $2`,
        [ownerId, id],
      );
      const row = result.rows[0];
      if (!row) return null;
      const encryptedAgentFields = [
        row.user_agent_ciphertext,
        row.user_agent_iv,
        row.user_agent_tag,
      ];
      if (
        encryptedAgentFields.some((value) => value !== null) &&
        encryptedAgentFields.some((value) => value === null)
      ) {
        throw new Error('Stored account User-Agent is incomplete.');
      }
      const account: EncryptedAccountSecret = {
        id: row.id,
        ownerId: row.owner_id,
        ...(row.claimed_handle ? { claimedHandle: row.claimed_handle } : {}),
        ciphertext: row.cookie_ciphertext,
        iv: row.cookie_iv,
        tag: row.cookie_tag,
        ...(row.user_agent_ciphertext && row.user_agent_iv && row.user_agent_tag
          ? {
              userAgent: {
                ciphertext: row.user_agent_ciphertext,
                iv: row.user_agent_iv,
                tag: row.user_agent_tag,
              },
            }
          : {}),
      };
      return account;
    },
    async setVerification(ownerId, id, identity) {
      const result = await pool.query<AccountRow>(
        `UPDATE livehub_account_imports
         SET verification_status = $3,
             verified_username = $4,
             verified_user_id = $5,
             avatar_url = $6,
             verified_at = CASE WHEN $3 = 'connected' THEN NOW() ELSE NULL END
         WHERE owner_id = $1 AND id = $2
         RETURNING ${publicColumns}`,
        [
          ownerId,
          id,
          identity ? 'connected' : 'disconnected',
          identity?.username ?? null,
          identity?.userId ?? null,
          identity?.avatarUrl ?? null,
        ],
      );
      return result.rows[0] ? metadata(result.rows[0]) : null;
    },
  };
}
