import type { Pool } from 'pg';

export interface LiveVideo {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface EncryptedValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export interface LiveConfigRow {
  videoId: string;
  rtmpUrl: EncryptedValue;
  streamKey: EncryptedValue;
}

export interface LiveStore {
  accountStatus(ownerId: string, accountId: string): Promise<string | null>;
  listVideos(ownerId: string): Promise<LiveVideo[]>;
  findVideo(ownerId: string, videoId: string): Promise<LiveVideo | null>;
  insertVideo(ownerId: string, video: LiveVideo): Promise<void>;
  deleteVideo(ownerId: string, videoId: string): Promise<'deleted' | 'in_use' | 'missing'>;
  videoUsage(ownerId: string): Promise<{ count: number; bytes: number }>;
  listConfiguredAccountIds(ownerId: string): Promise<string[]>;
  getConfig(ownerId: string, accountId: string): Promise<LiveConfigRow | null>;
  saveConfig(ownerId: string, accountId: string, config: LiveConfigRow): Promise<void>;
}

export async function ensureLiveTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS livehub_live_videos (
      id UUID PRIMARY KEY,
      owner_id VARCHAR(128) NOT NULL,
      name VARCHAR(128) NOT NULL,
      size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS livehub_live_videos_owner_created_idx
      ON livehub_live_videos (owner_id, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS livehub_live_configs (
      account_id UUID PRIMARY KEY REFERENCES livehub_account_imports(id) ON DELETE CASCADE,
      owner_id VARCHAR(128) NOT NULL,
      video_id UUID NOT NULL REFERENCES livehub_live_videos(id),
      rtmp_ciphertext BYTEA NOT NULL,
      rtmp_iv BYTEA NOT NULL,
      rtmp_tag BYTEA NOT NULL,
      stream_key_ciphertext BYTEA NOT NULL,
      stream_key_iv BYTEA NOT NULL,
      stream_key_tag BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS livehub_live_configs_owner_idx
      ON livehub_live_configs (owner_id)
  `);
}

export function createPgLiveStore(pool: Pool): LiveStore {
  return {
    async accountStatus(ownerId, accountId) {
      const result = await pool.query<{ verification_status: string }>(
        'SELECT verification_status FROM livehub_account_imports WHERE owner_id = $1 AND id = $2',
        [ownerId, accountId],
      );
      return result.rows[0]?.verification_status ?? null;
    },
    async listVideos(ownerId) {
      const result = await pool.query<{
        id: string;
        name: string;
        size_bytes: string;
        created_at: Date;
      }>(
        `SELECT id, name, size_bytes, created_at FROM livehub_live_videos
         WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
        [ownerId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        sizeBytes: Number(row.size_bytes),
        createdAt: new Date(row.created_at).toISOString(),
      }));
    },
    async findVideo(ownerId, videoId) {
      const result = await pool.query<{
        id: string;
        name: string;
        size_bytes: string;
        created_at: Date;
      }>(
        `SELECT id, name, size_bytes, created_at FROM livehub_live_videos
         WHERE owner_id = $1 AND id = $2`,
        [ownerId, videoId],
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            name: row.name,
            sizeBytes: Number(row.size_bytes),
            createdAt: new Date(row.created_at).toISOString(),
          }
        : null;
    },
    async insertVideo(ownerId, video) {
      await pool.query(
        `INSERT INTO livehub_live_videos (id, owner_id, name, size_bytes, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [video.id, ownerId, video.name, video.sizeBytes, video.createdAt],
      );
    },
    async videoUsage(ownerId) {
      const result = await pool.query<{ count: string; bytes: string }>(
        `SELECT COUNT(*)::text AS count, COALESCE(SUM(size_bytes), 0)::text AS bytes
         FROM livehub_live_videos WHERE owner_id = $1`,
        [ownerId],
      );
      return { count: Number(result.rows[0].count), bytes: Number(result.rows[0].bytes) };
    },
    async deleteVideo(ownerId, videoId) {
      try {
        const deleted = await pool.query<{ id: string }>(
          `DELETE FROM livehub_live_videos v
           WHERE v.owner_id = $1 AND v.id = $2
             AND NOT EXISTS (SELECT 1 FROM livehub_live_configs c WHERE c.video_id = v.id)
           RETURNING id`,
          [ownerId, videoId],
        );
        if (deleted.rows.length) return 'deleted';
      } catch (error) {
        if ((error as { code?: string }).code === '23503') return 'in_use';
        throw error;
      }
      const existing = await pool.query<{ id: string }>(
        'SELECT id FROM livehub_live_videos WHERE owner_id = $1 AND id = $2',
        [ownerId, videoId],
      );
      return existing.rows.length ? 'in_use' : 'missing';
    },
    async listConfiguredAccountIds(ownerId) {
      const result = await pool.query<{ account_id: string }>(
        'SELECT account_id FROM livehub_live_configs WHERE owner_id = $1',
        [ownerId],
      );
      return result.rows.map((row) => row.account_id);
    },
    async getConfig(ownerId, accountId) {
      const result = await pool.query<{
        video_id: string;
        rtmp_ciphertext: Buffer;
        rtmp_iv: Buffer;
        rtmp_tag: Buffer;
        stream_key_ciphertext: Buffer;
        stream_key_iv: Buffer;
        stream_key_tag: Buffer;
      }>(
        `SELECT video_id, rtmp_ciphertext, rtmp_iv, rtmp_tag,
                stream_key_ciphertext, stream_key_iv, stream_key_tag
         FROM livehub_live_configs WHERE owner_id = $1 AND account_id = $2`,
        [ownerId, accountId],
      );
      const row = result.rows[0];
      return row
        ? {
            videoId: row.video_id,
            rtmpUrl: {
              ciphertext: row.rtmp_ciphertext,
              iv: row.rtmp_iv,
              tag: row.rtmp_tag,
            },
            streamKey: {
              ciphertext: row.stream_key_ciphertext,
              iv: row.stream_key_iv,
              tag: row.stream_key_tag,
            },
          }
        : null;
    },
    async saveConfig(ownerId, accountId, config) {
      await pool.query(
        `INSERT INTO livehub_live_configs
          (owner_id, account_id, video_id, rtmp_ciphertext, rtmp_iv, rtmp_tag,
           stream_key_ciphertext, stream_key_iv, stream_key_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (account_id) DO UPDATE SET
           video_id = EXCLUDED.video_id,
           rtmp_ciphertext = EXCLUDED.rtmp_ciphertext,
           rtmp_iv = EXCLUDED.rtmp_iv,
           rtmp_tag = EXCLUDED.rtmp_tag,
           stream_key_ciphertext = EXCLUDED.stream_key_ciphertext,
           stream_key_iv = EXCLUDED.stream_key_iv,
           stream_key_tag = EXCLUDED.stream_key_tag,
           updated_at = NOW()
         WHERE livehub_live_configs.owner_id = EXCLUDED.owner_id`,
        [
          ownerId,
          accountId,
          config.videoId,
          config.rtmpUrl.ciphertext,
          config.rtmpUrl.iv,
          config.rtmpUrl.tag,
          config.streamKey.ciphertext,
          config.streamKey.iv,
          config.streamKey.tag,
        ],
      );
    },
  };
}
