import Fastify from 'fastify';
import { createRequire } from 'node:module';
import {
  decryptAccountCookie,
  decryptAccountUserAgent,
  encryptAccountCookie,
  encryptAccountUserAgent,
  lookupTikTokIdentity,
  newAccountId,
  tokenMatches,
  validAlias,
  validLiveTitle,
  validOwnerId,
  validateAccountConfig,
  type AccountConfig,
  type StoredAccount,
} from './accounts.js';
import { registerLiveRoutes } from './live-routes.js';
import type { LiveService } from './live-service.js';

const require = createRequire(import.meta.url);
const { createMockEvent, validateEvent } =
  require('@live-hub/shared') as typeof import('@live-hub/shared');
const {
  createTikTokClient,
  createMockTransport,
  mockAccountId,
  mockLiveSessionId,
  parseAccountImportCurl,
} = require('@live-hub/tiktok-client') as typeof import('@live-hub/tiktok-client');
const mockClient = createTikTokClient(createMockTransport());

export type HealthDependencies = {
  postgres: () => Promise<void>;
  redis: () => Promise<void>;
  worker: () => Promise<boolean>;
};

export function createApp(
  deps: HealthDependencies,
  accountConfig?: AccountConfig,
  liveService?: LiveService,
) {
  if (accountConfig) validateAccountConfig(accountConfig);
  const app = Fastify({ logger: false });

  function ownerFromHeaders(headers: Record<string, unknown>): string | null {
    if (!accountConfig) return null;
    const token = headers['x-internal-token'];
    const owner = headers['x-livehub-owner'];
    if (
      !tokenMatches(token as string | string[] | undefined, accountConfig.internalToken) ||
      !validOwnerId(owner as string | string[] | undefined)
    ) {
      return null;
    }
    return owner as string;
  }

  function validAccountId(id: string | undefined): id is string {
    return !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  app.get('/health/live', async () => ({ status: 'alive', service: 'api' }));

  app.get('/health/ready', async (_request, reply) => {
    const [postgres, redis, worker] = await Promise.allSettled([
      deps.postgres(),
      deps.redis(),
      deps.worker(),
    ]);
    const services = {
      postgres: postgres.status === 'fulfilled' ? 'ready' : 'unavailable',
      redis: redis.status === 'fulfilled' ? 'ready' : 'unavailable',
      worker: worker.status === 'fulfilled' && worker.value ? 'ready' : 'unavailable',
    } as const;
    const status = Object.values(services).every((value) => value === 'ready')
      ? 'ready'
      : 'degraded';
    if (status === 'degraded') reply.status(503);
    return { status, service: 'api', dependencies: services };
  });

  app.get('/api/v1/integrations', async () => ({
    items: [
      { name: 'tiktok-auth', status: 'pending_verification', owner: 'Nott' },
      { name: 'live-stats', status: 'pending_verification', owner: 'C' },
      { name: 'product-search-add-pin', status: 'pending_verification', owner: 'C' },
      { name: 'comment-chat', status: 'pending_contract', owner: 'Phum' },
    ],
  }));

  app.get('/api/v1/mock/live-stats', async () => {
    const result = await mockClient.stats.live({
      accountId: mockAccountId,
      liveSessionId: mockLiveSessionId,
    });
    if (!result.ok) return result;
    const stats = result.data;
    const event = createMockEvent(
      'stats.updated',
      {
        accountId: stats.accountId,
        viewers: stats.viewers,
        sold: stats.sold,
        enters: stats.enters,
        likes: stats.likes,
        comments: stats.comments,
        impressions: stats.impressions,
        gmv: stats.gmv,
        currency: stats.currency,
        gmvPerHour: stats.gmvPerHour,
        impressionsPerHour: stats.impressionsPerHour,
      },
      { accountId: stats.accountId, sessionId: stats.liveSessionId },
    );
    return { ...result, event, contract: validateEvent(event).success ? 'valid' : 'invalid' };
  });

  app.get('/api/v1/mock/products', async () =>
    mockClient.products.search({ accountId: mockAccountId, query: 'demo' }),
  );

  app.get('/api/v1/accounts', async (request, reply) => {
    if (!accountConfig) return reply.status(503).send({ error: 'Account import is unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    try {
      return { items: await accountConfig.store.list(ownerId) };
    } catch {
      return reply.status(503).send({ error: 'Account storage is unavailable.' });
    }
  });

  app.post('/api/v1/accounts/import', { bodyLimit: 70_000 }, async (request, reply) => {
    if (!accountConfig) return reply.status(503).send({ error: 'Account import is unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const body = request.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['alias', 'curl', 'sessionid', 'liveTitle'].includes(key))
    ) {
      return reply.status(400).send({ error: 'Invalid account import request.' });
    }
    const values = body as Record<string, unknown>;
    if (
      !validAlias(values.alias) ||
      (values.liveTitle !== undefined && !validLiveTitle(values.liveTitle)) ||
      (typeof values.curl === 'string') === (typeof values.sessionid === 'string')
    ) {
      return reply.status(400).send({ error: 'Invalid account import request.' });
    }

    let parsed: Pick<
      ReturnType<typeof parseAccountImportCurl>,
      'cookieHeader' | 'userAgent' | 'claimedHandle'
    >;
    if (typeof values.sessionid === 'string') {
      if (!/^[A-Za-z0-9._~%-]{16,512}$/.test(values.sessionid)) {
        return reply.status(400).send({ error: 'Invalid TikTok session ID.' });
      }
      parsed = { cookieHeader: `sessionid=${values.sessionid}` };
    } else {
      if (typeof values.curl !== 'string' || !values.curl || values.curl.length > 64_000) {
        return reply.status(400).send({ error: 'Invalid account import cURL.' });
      }
      try {
        parsed = parseAccountImportCurl(values.curl);
      } catch {
        return reply.status(400).send({ error: 'Invalid account import cURL.' });
      }
    }

    let identity;
    try {
      identity = await (accountConfig.identityLookup ?? lookupTikTokIdentity)(
        parsed.cookieHeader,
        parsed.userAgent,
      );
    } catch {
      return reply.status(503).send({ error: 'TikTok account check is unavailable.' });
    }
    if (!identity) return reply.status(422).send({ error: 'TikTok session is not authenticated.' });

    const id = newAccountId();
    const stored: StoredAccount = {
      id,
      ownerId,
      alias: values.alias.trim(),
      liveTitle: typeof values.liveTitle === 'string' ? values.liveTitle.trim() : '',
      ...(parsed.claimedHandle === undefined ? {} : { claimedHandle: parsed.claimedHandle }),
      verifiedHandle: identity.username,
      verifiedUserId: identity.userId,
      ...(identity.avatarUrl === undefined ? {} : { avatarUrl: identity.avatarUrl }),
      verifiedAt: new Date().toISOString(),
      verificationStatus: 'connected',
      probe: 'not_run',
      probeHttpStatus: null,
      createdAt: new Date().toISOString(),
      ...encryptAccountCookie(parsed.cookieHeader, accountConfig.encryptionKey, ownerId, id),
      ...(parsed.userAgent === undefined
        ? {}
        : {
            userAgent: encryptAccountUserAgent(
              parsed.userAgent,
              accountConfig.encryptionKey,
              ownerId,
              id,
            ),
          }),
    };
    try {
      const item = await accountConfig.store.insert(stored);
      return reply.status(201).send({ item });
    } catch {
      return reply.status(503).send({ error: 'Account storage is unavailable.' });
    }
  });

  app.patch('/api/v1/accounts/:id', async (request, reply) => {
    if (!accountConfig)
      return reply.status(503).send({ error: 'Account settings are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id?: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid account ID.' });
    const body = request.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      Object.keys(body).some((key) => !['alias', 'liveTitle'].includes(key))
    ) {
      return reply.status(400).send({ error: 'Invalid account settings.' });
    }
    const values = body as Record<string, unknown>;
    if (!validAlias(values.alias) || !validLiveTitle(values.liveTitle)) {
      return reply.status(400).send({ error: 'Invalid account settings.' });
    }
    try {
      const item = await accountConfig.store.updateSettings(ownerId, id, {
        alias: values.alias.trim(),
        liveTitle: values.liveTitle.trim(),
      });
      if (!item) return reply.status(404).send({ error: 'Account not found.' });
      return { item };
    } catch {
      return reply.status(503).send({ error: 'Account storage is unavailable.' });
    }
  });

  app.delete('/api/v1/accounts/:id', async (request, reply) => {
    if (!accountConfig)
      return reply.status(503).send({ error: 'Account deletion is unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id?: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid account ID.' });
    const releaseDeletion = liveService?.beginAccountDeletion(ownerId, id);
    if (liveService && !releaseDeletion) {
      return reply
        .status(409)
        .send({ error: 'Stop the live stream before deleting this account.' });
    }
    try {
      if (!(await accountConfig.store.delete(ownerId, id))) {
        return reply.status(404).send({ error: 'Account not found.' });
      }
      return reply.status(204).send();
    } catch {
      return reply.status(503).send({ error: 'Account storage is unavailable.' });
    } finally {
      releaseDeletion?.();
    }
  });

  app.post('/api/v1/accounts/:id/verify', async (request, reply) => {
    if (!accountConfig) return reply.status(503).send({ error: 'Account checks are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id?: string };
    if (!validAccountId(id)) {
      return reply.status(400).send({ error: 'Invalid account ID.' });
    }
    try {
      const encrypted = await accountConfig.store.findEncrypted(ownerId, id);
      if (!encrypted) return reply.status(404).send({ error: 'Account not found.' });
      const cookieHeader = decryptAccountCookie(
        encrypted,
        accountConfig.encryptionKey,
        ownerId,
        id,
      );
      const userAgent = encrypted.userAgent
        ? decryptAccountUserAgent(encrypted.userAgent, accountConfig.encryptionKey, ownerId, id)
        : undefined;
      const identity = await (accountConfig.identityLookup ?? lookupTikTokIdentity)(
        cookieHeader,
        userAgent,
      );
      const item = await accountConfig.store.setVerification(ownerId, id, identity);
      if (!item) return reply.status(404).send({ error: 'Account not found.' });
      return { item };
    } catch {
      return reply.status(503).send({ error: 'TikTok account check is unavailable.' });
    }
  });

  if (liveService) registerLiveRoutes(app, liveService, ownerFromHeaders);

  return app;
}
