import { Pool } from 'pg';
import { createClient } from 'redis';
import { createApp } from './app.js';
import { createPgAccountStore, ensureAccountTable } from './account-store.js';
import { parseEncryptionKeyHex, type AccountConfig } from './accounts.js';
import { createPgLiveStore, ensureLiveTables } from './live-store.js';
import { promises as fsPromises } from 'node:fs';
import { createCloudTranscoder } from './cloud-transcode.js';
import { defaultConvertVideo, LiveService } from './live-service.js';
import { AutoLiveManager, ensureAutoLiveTable } from './auto-live.js';
import { SessionChat, ensureSessionChatTables } from './session-chat.js';
import { ChatBridge } from './chat-bridge.js';
import { createPgProductSetStore, ensureProductSetTable } from './product-set-store.js';
import {
  CommentReplyService,
  createPgCommentReplyStore,
  ensureCommentReplyTables,
} from './ai-comments.js';
import {
  createRapidApiRoomSigner,
  createTikTokLiveRoom,
  endTikTokLiveRoom,
  checkTikTokLiveRoom,
} from '@live-hub/tiktok-client';

const port = Number(process.env.API_PORT ?? 4000);
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://livehub:livehub_dev@localhost:5433/livehub';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380';
const configuredLiveLimit = process.env.MAX_CONCURRENT_LIVE?.trim();
const maxConcurrentLive = configuredLiveLimit ? Number(configuredLiveLimit) : null;
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
let autoLive: AutoLiveManager | undefined;
let commentReplies: CommentReplyService | undefined;
let chatBridge: ChatBridge | undefined;
let serverChat: SessionChat | undefined;
let chatTimer: ReturnType<typeof setInterval> | undefined;
if (accountConfig) {
  await ensureAccountTable(pool);
  await ensureLiveTables(pool);
  await ensureAutoLiveTable(pool);
  await ensureProductSetTable(pool);
  await ensureCommentReplyTables(pool);
  await ensureSessionChatTables(pool);
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
  const transcodeBucket = process.env.TRANSCODE_BUCKET?.trim();
  const cloudTranscode = transcodeBucket
    ? createCloudTranscoder({
        bucket: transcodeBucket,
        location: process.env.TRANSCODE_LOCATION || undefined,
      })
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
    rapidApiKey
      ? async ({ cookieHeader, userAgent, roomId, streamId }) =>
          checkTikTokLiveRoom(
            {
              cookieHeader,
              roomId,
              streamId,
              studioVersion: process.env.TIKTOK_STUDIO_VERSION ?? '1.36.6',
              deviceId: process.env.TIKTOK_STUDIO_DEVICE_ID ?? '0',
              installId: process.env.TIKTOK_STUDIO_INSTALL_ID ?? '0',
              ...(userAgent ? { userAgent } : {}),
            },
            createRapidApiRoomSigner(rapidApiKey),
          )
      : undefined,
    maxConcurrentLive,
    transcodeBucket
      ? async (source, destination, signal) => {
          try {
            await cloudTranscode!(source, destination, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            console.error(
              '[live] cloud transcode failed, using local ffmpeg:',
              error instanceof Error ? error.message : 'unknown error',
            );
            await fsPromises.rm(destination, { force: true });
            await defaultConvertVideo(source, destination, signal);
          }
        }
      : undefined,
  );
  void liveService.recoverUploads().catch(() => undefined);
  autoLive = new AutoLiveManager(pool, liveService, accountConfig.store);
  chatBridge = new ChatBridge(async (owner, account) => {
    const roomId = await liveService!.currentRoomId(owner, account);
    const session = await liveService!.session(owner, account);
    const metadata = (await accountConfig.store.list(owner)).find((a) => a.id === account);
    const userId = await accountConfig.store.getVerifiedUserId(owner, account);
    if (!roomId || session.status !== 'live' || !metadata?.verifiedHandle || !userId) return null;
    return { roomId, handle: metadata.verifiedHandle.replace(/^@/, ''), userId };
  });
  serverChat = new SessionChat(pool, accountConfig.encryptionKey, async (owner, account) => {
    const metadata = (await accountConfig.store.list(owner)).find((a) => a.id === account);
    const userId = await accountConfig.store.getVerifiedUserId(owner, account);
    if (!userId || metadata?.verificationStatus !== 'connected' || !metadata.verifiedHandle)
      return null;
    return {
      handle: metadata.verifiedHandle.replace(/^@/, ''),
      userId,
    };
  });
  commentReplies = new CommentReplyService(
    createPgCommentReplyStore(pool, accountConfig.encryptionKey),
    undefined,
    serverChat,
  );
  chatBridge.attach(commentReplies);
  serverChat.attach(commentReplies);
  let chatSyncing = false;
  chatTimer = setInterval(() => {
    if (chatSyncing) return;
    chatSyncing = true;
    void pool
      .query<{ owner_id: string; account_id: string }>(
        "SELECT owner_id,account_id FROM livehub_ai_reply_settings WHERE settings->>'enabled' = 'true'",
      )
      .then(async (r) => {
        for (const row of r.rows) await serverChat!.ready(row.owner_id, row.account_id);
      })
      .catch(() => {})
      .finally(() => {
        chatSyncing = false;
      });
  }, 10000);
  chatTimer.unref();
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
  autoLive,
  commentReplies,
  chatBridge,
);

async function shutdown() {
  chatBridge?.close();
  if (chatTimer) clearInterval(chatTimer);
  await serverChat?.close();
  autoLive?.stop();
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
autoLive?.start();
console.log(`API listening on ${port}`);
