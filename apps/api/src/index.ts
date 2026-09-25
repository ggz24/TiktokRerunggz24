import { Pool } from 'pg';
import { createClient } from 'redis';
import { createApp } from './app.js';
import { createPgAccountStore, ensureAccountTable } from './account-store.js';
import { parseEncryptionKeyHex, type AccountConfig } from './accounts.js';

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
if (accountConfig) await ensureAccountTable(pool);

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
