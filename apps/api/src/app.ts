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
import { sendLiveProductAdd, type ProductAddSender } from './live-product-add.js';
import type { ProductSetInput, ProductSetStore } from './product-set-store.js';

const require = createRequire(import.meta.url);
const { createMockEvent, validateEvent } =
  require('@live-hub/shared') as typeof import('@live-hub/shared');
const {
  createTikTokClient,
  createMockTransport,
  mockAccountId,
  mockLiveSessionId,
  parseAccountImportCurl,
  parseLiveProductAddCurl,
  forLiveProductRoom,
} = require('@live-hub/tiktok-client') as typeof import('@live-hub/tiktok-client');
const mockClient = createTikTokClient(createMockTransport());

// TikTok Shop may require cookies that are absent from a general TikTok account import.
// Use the captured Shop session only when it belongs to the selected account.
function shopCookieForAccount(shopCookie: string | undefined, accountCookie: string): string {
  const sessionId = (header: string) =>
    header
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('sessionid='))
      ?.slice('sessionid='.length);
  const accountSession = sessionId(accountCookie);
  return accountSession && shopCookie && sessionId(shopCookie) === accountSession
    ? shopCookie
    : accountCookie;
}

export type HealthDependencies = {
  postgres: () => Promise<void>;
  redis: () => Promise<void>;
  worker: () => Promise<boolean>;
};

export function createApp(
  deps: HealthDependencies,
  accountConfig?: AccountConfig,
  liveService?: LiveService,
  productAddSender: ProductAddSender = sendLiveProductAdd,
  productSetStore?: ProductSetStore,
) {
  if (accountConfig) validateAccountConfig(accountConfig);
  const app = Fastify({ logger: false, requestTimeout: 3_600_000 });

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

  function productCurlFromBody(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const values = body as Record<string, unknown>;
    if (Object.keys(values).some((key) => !['curl', 'accountId'].includes(key))) return null;
    if (typeof values.curl !== 'string' || values.curl.length > 100_000) return null;
    if (
      values.accountId !== undefined &&
      (typeof values.accountId !== 'string' || !validAccountId(values.accountId))
    )
      return null;
    try {
      return {
        parsed: parseLiveProductAddCurl(values.curl),
        accountId: values.accountId as string | undefined,
      };
    } catch {
      return null;
    }
  }

  app.post('/api/v1/live/products/preview', { bodyLimit: 110_000 }, async (request, reply) => {
    if (!accountConfig) return reply.status(503).send({ error: 'Product import is unavailable.' });
    if (!ownerFromHeaders(request.headers))
      return reply.status(401).send({ error: 'Unauthorized.' });
    const input = productCurlFromBody(request.body);
    if (!input) return reply.status(400).send({ error: 'Invalid product-add cURL.' });
    return {
      roomId: input.parsed.roomId,
      productIds: input.parsed.productIds,
      hasCookie: Boolean(input.parsed.cookieHeader),
    };
  });

  app.post('/api/v1/live/products/add', { bodyLimit: 110_000 }, async (request, reply) => {
    if (!accountConfig) return reply.status(503).send({ error: 'Product import is unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const input = productCurlFromBody(request.body);
    if (!input) return reply.status(400).send({ error: 'Invalid product-add cURL.' });
    if (input.accountId && liveService) {
      try {
        const roomId = await liveService.currentRoomId(ownerId, input.accountId);
        if (!roomId)
          return reply
            .status(409)
            .send({ error: 'Save this as a product set and queue it before LIVE.' });
        const account = await accountConfig.store.findEncrypted(ownerId, input.accountId);
        if (!account) return reply.status(404).send({ error: 'Account not found.' });
        const cookieHeader = decryptAccountCookie(
          account,
          accountConfig.encryptionKey,
          ownerId,
          input.accountId,
        );
        const outcome = await productAddSender(
          forLiveProductRoom(input.parsed, roomId),
          shopCookieForAccount(input.parsed.cookieHeader, cookieHeader),
        );
        const result = { outcome, roomId, productCount: input.parsed.productIds.length };
        if (outcome === 'rejected') return reply.status(422).send(result);
        if (outcome === 'unverified') return reply.status(202).send(result);
        return result;
      } catch {
        return reply.status(503).send({ error: 'TikTok Shop request is unavailable.' });
      }
    }
    let cookieHeader = input.parsed.cookieHeader;
    if (!cookieHeader) {
      if (!input.accountId) return reply.status(400).send({ error: 'Select a connected account.' });
      try {
        const encrypted = await accountConfig.store.findEncrypted(ownerId, input.accountId);
        if (!encrypted) return reply.status(404).send({ error: 'Account not found.' });
        cookieHeader = decryptAccountCookie(
          encrypted,
          accountConfig.encryptionKey,
          ownerId,
          input.accountId,
        );
      } catch {
        return reply.status(503).send({ error: 'Account session is unavailable.' });
      }
    }
    try {
      const outcome = await productAddSender(input.parsed, cookieHeader);
      const result = {
        outcome,
        roomId: input.parsed.roomId,
        productCount: input.parsed.productIds.length,
      };
      if (outcome === 'rejected') return reply.status(422).send(result);
      if (outcome === 'unverified') return reply.status(202).send(result);
      return result;
    } catch {
      return reply.status(503).send({ error: 'TikTok Shop request is unavailable.' });
    }
  });

  function productSetBody(body: unknown, previous?: ProductSetInput): ProductSetInput | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const values = body as Record<string, unknown>;
    if (Object.keys(values).some((key) => !['name', 'curl', 'accountId'].includes(key)))
      return null;
    if (!validAlias(values.name)) return null;
    if (
      values.curl !== undefined &&
      (typeof values.curl !== 'string' || values.curl.length > 100_000)
    )
      return null;
    const curl = values.curl ?? previous?.curl;
    if (typeof curl !== 'string') return null;
    const accountId =
      values.accountId === undefined ? (previous?.accountId ?? null) : values.accountId;
    if (accountId !== null && (typeof accountId !== 'string' || !validAccountId(accountId)))
      return null;
    try {
      const parsed = parseLiveProductAddCurl(curl);
      if (!parsed.cookieHeader && !accountId) return null;
      return {
        name: values.name.trim(),
        accountId,
        curl,
        roomId: parsed.roomId,
        productIds: parsed.productIds,
        hasCookie: Boolean(parsed.cookieHeader),
      };
    } catch {
      return null;
    }
  }

  async function selectedAccountExists(ownerId: string, accountId: string | null) {
    if (!accountId || !accountConfig) return true;
    return Boolean(await accountConfig.store.findEncrypted(ownerId, accountId));
  }

  async function sendSavedSetToRoom(ownerId: string, saved: ProductSetInput, roomId: string) {
    if (!accountConfig || !saved.accountId) throw new Error('A connected account is required.');
    const account = await accountConfig.store.findEncrypted(ownerId, saved.accountId);
    if (!account) throw new Error('Account not found.');
    const cookieHeader = decryptAccountCookie(
      account,
      accountConfig.encryptionKey,
      ownerId,
      saved.accountId,
    );
    const parsed = forLiveProductRoom(parseLiveProductAddCurl(saved.curl), roomId);
    return productAddSender(parsed, shopCookieForAccount(parsed.cookieHeader, cookieHeader));
  }

  app.get('/api/v1/live/product-sets', async (request, reply) => {
    if (!productSetStore) return reply.status(503).send({ error: 'Product sets are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    try {
      return { items: await productSetStore.list(ownerId) };
    } catch {
      return reply.status(503).send({ error: 'Product sets are unavailable.' });
    }
  });

  app.post('/api/v1/live/product-sets', { bodyLimit: 110_000 }, async (request, reply) => {
    if (!productSetStore) return reply.status(503).send({ error: 'Product sets are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const input = productSetBody(request.body);
    if (!input) return reply.status(400).send({ error: 'Invalid product set.' });
    try {
      if (!(await selectedAccountExists(ownerId, input.accountId))) {
        return reply.status(404).send({ error: 'Account not found.' });
      }
      return reply.status(201).send({ item: await productSetStore.create(ownerId, input) });
    } catch {
      return reply.status(503).send({ error: 'Product set could not be saved.' });
    }
  });

  app.patch('/api/v1/live/product-sets/:id', { bodyLimit: 110_000 }, async (request, reply) => {
    if (!productSetStore) return reply.status(503).send({ error: 'Product sets are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid product set ID.' });
    try {
      const previous = await productSetStore.find(ownerId, id);
      if (!previous) return reply.status(404).send({ error: 'Product set not found.' });
      const input = productSetBody(request.body, previous);
      if (!input) return reply.status(400).send({ error: 'Invalid product set.' });
      if (!(await selectedAccountExists(ownerId, input.accountId))) {
        return reply.status(404).send({ error: 'Account not found.' });
      }
      const item = await productSetStore.update(ownerId, id, input);
      return item ? { item } : reply.status(404).send({ error: 'Product set not found.' });
    } catch {
      return reply.status(503).send({ error: 'Product set could not be updated.' });
    }
  });

  app.delete('/api/v1/live/product-sets/:id', async (request, reply) => {
    if (!productSetStore) return reply.status(503).send({ error: 'Product sets are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid product set ID.' });
    try {
      const deleted = await productSetStore.delete(ownerId, id);
      return deleted
        ? reply.status(204).send()
        : reply.status(404).send({ error: 'Product set not found.' });
    } catch {
      return reply.status(503).send({ error: 'Product set could not be deleted.' });
    }
  });

  app.post('/api/v1/live/product-sets/:id/send', async (request, reply) => {
    if (!productSetStore || !accountConfig)
      return reply.status(503).send({ error: 'Product sets are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid product set ID.' });
    try {
      const saved = await productSetStore.find(ownerId, id);
      if (!saved) return reply.status(404).send({ error: 'Product set not found.' });
      if (saved.accountId && liveService) {
        const roomId = await liveService.currentRoomId(ownerId, saved.accountId);
        await productSetStore.selectForLive(ownerId, id);
        if (!roomId) {
          return { outcome: 'queued', roomId: '', productCount: saved.productIds.length };
        }
        const outcome = await sendSavedSetToRoom(ownerId, saved, roomId);
        const result = { outcome, roomId, productCount: saved.productIds.length };
        if (outcome === 'rejected') return reply.status(422).send(result);
        if (outcome === 'unverified') return reply.status(202).send(result);
        return result;
      }
      const parsed = parseLiveProductAddCurl(saved.curl);
      let cookieHeader = parsed.cookieHeader;
      if (!cookieHeader) {
        if (!saved.accountId)
          return reply.status(400).send({ error: 'Select a connected account.' });
        const account = await accountConfig.store.findEncrypted(ownerId, saved.accountId);
        if (!account) return reply.status(404).send({ error: 'Account not found.' });
        cookieHeader = decryptAccountCookie(
          account,
          accountConfig.encryptionKey,
          ownerId,
          saved.accountId,
        );
      }
      const outcome = await productAddSender(parsed, cookieHeader);
      const result = { outcome, roomId: parsed.roomId, productCount: parsed.productIds.length };
      if (outcome === 'rejected') return reply.status(422).send(result);
      if (outcome === 'unverified') return reply.status(202).send(result);
      return result;
    } catch {
      return reply.status(503).send({ error: 'Product set request is unavailable.' });
    }
  });

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

  if (liveService)
    registerLiveRoutes(app, liveService, ownerFromHeaders, async (ownerId, accountId, roomId) => {
      if (!productSetStore || !accountConfig) return 'none';
      const sets = await productSetStore.list(ownerId);
      const selected = sets.find((item) => item.accountId === accountId && item.autoApply);
      if (!selected) return 'none';
      const saved = await productSetStore.find(ownerId, selected.id);
      if (!saved) return 'none';
      try {
        return await sendSavedSetToRoom(ownerId, saved, roomId);
      } catch {
        return 'unverified';
      }
    });

  return app;
}
