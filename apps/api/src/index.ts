import { Pool } from 'pg';
import { createClient } from 'redis';
import { createApp } from './app.js';
import { createPgAccountStore, ensureAccountTable } from './account-store.js';
import { parseEncryptionKeyHex, type AccountConfig } from './accounts.js';
import { createPgLiveStore, ensureLiveTables } from './live-store.js';
import { LiveService } from './live-service.js';
import { createPgProductSetStore, ensureProductSetTable } from './product-set-store.js';
import {
  createRapidApiRoomSigner,
  createTikTokLiveRoom,
  endTikTokLiveRoom,
} from '@live-hub/tiktok-client';

const port = Number(process.env.API_PORT ?? 4000);
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://livehub:livehub_dev@localhost:5433/livehub';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380';
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
const redis = createClient({
  url: redisUrl,
  socket: { connectTimeout: 2000, reconnectStrategy: false },
});
redis.on('error', () => {});

const keyHex = process.env.ACCOUNT_ENCRYPTION_KEY;
const internalToken = process.env.INTERNAL_API_TOKEN;
if ((keyHex === undefined) !== (internalToken === undefined)) {
  throw new Error('Account import configuration is incomplete.');
}
const accountConfig: AccountConfig | undefined =
  keyHex && internalToken
    ? {
        store: createPgAccountStore(pool),
        encryptionKey: parseEncryptionKeyHex(keyHex),
        internalToken,
      }
    : undefined;
let liveService: LiveService | undefined;
if (accountConfig) {
  await ensureAccountTable(pool);
  await ensureLiveTables(pool);
  await ensureProductSetTable(pool);
  const rapidApiKey = process.env.RAPIDAPI_KEY?.trim();
  const autoRoomCreator = rapidApiKey
    ? async ({
        title,
        cookieHeader,
        userAgent,
      }: {
        title: string;
        cookieHeader: string;
        userAgent?: string;
      }) => {
        const room = await createTikTokLiveRoom(
          {
            title,
            cookieHeader,
            categoryId: process.env.TIKTOK_LIVE_CATEGORY_ID ?? '0',
            studioVersion: process.env.TIKTOK_STUDIO_VERSION ?? '1.36.6',
            deviceId: process.env.TIKTOK_STUDIO_DEVICE_ID ?? '0',
            installId: process.env.TIKTOK_STUDIO_INSTALL_ID ?? '0',
            ...(userAgent ? { userAgent } : {}),
          },
          createRapidApiRoomSigner(rapidApiKey),
        );
        return room;
      }
    : undefined;
  const autoRoomEnder = rapidApiKey
    ? async ({
        cookieHeader,
        userAgent,
        roomId,
        streamId,
      }: {
        cookieHeader: string;
        userAgent?: string;
        roomId?: string | null;
        streamId?: string | null;
      }) =>
        endTikTokLiveRoom(
          {
            cookieHeader,
            studioVersion: process.env.TIKTOK_STUDIO_VERSION ?? '1.36.6',
            deviceId: process.env.TIKTOK_STUDIO_DEVICE_ID ?? '0',
            installId: process.env.TIKTOK_STUDIO_INSTALL_ID ?? '0',
            roomId,
            streamId,
            ...(userAgent ? { userAgent } : {}),
          },
          createRapidApiRoomSigner(rapidApiKey),
        )
    : undefined;
  liveService = new LiveService(
    createPgLiveStore(pool),
    accountConfig.store,
    accountConfig.encryptionKey,
    process.env.LIVE_MEDIA_DIR ?? './media',
    undefined,
    undefined,
    undefined,
    autoRoomCreator,
    autoRoomEnder,
  );
}

const app = createApp(
  {
    postgres: async () => {
      await pool.query('SELECT 1');
    },
    redis: async () => {
      if (!redis.isOpen) await redis.connect();
      await redis.ping();
    },
    worker: async () => {
      if (!redis.isOpen) await redis.connect();
      return Boolean(await redis.get('livehub:worker:heartbeat'));
    },
  },
  accountConfig,
  liveService,
  undefined,
  accountConfig ? createPgProductSetStore(pool, accountConfig.encryptionKey) : undefined,
);

async function shutdown() {
  await app.close();
  await pool.end();
  if (redis.isOpen) await redis.quit();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

await app.listen({ port, host: process.env.API_HOST ?? '127.0.0.1' });
console.log(`API listening on ${port}`);
