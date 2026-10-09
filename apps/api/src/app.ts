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
import type { AutoLiveManager } from './auto-live.js';
import type { ProductPinStore } from './product-pin-store.js';
import { createRoundProductActions, pinSelectedProduct } from './round-products.js';
import type { LiveService } from './live-service.js';
import { LiveError } from './live-service.js';
import { sendLiveProductAdd, type ProductAddSender } from './live-product-add.js';
import type { ProductSetInput, ProductSetStore } from './product-set-store.js';
import type { CommentReplyService } from './ai-comments.js';
import { registerAiCommentRoutes } from './ai-comment-routes.js';
import type { ChatBridge } from './chat-bridge.js';
import { registerChatBridgeRoutes } from './chat-bridge-routes.js';
import type { BoxphoneService } from './boxphone.js';
import { registerBoxphoneRoutes } from './boxphone-routes.js';
import type { StatsSourceService } from './stats-sources.js';
import { registerStatsSourceRoutes } from './stats-sources-routes.js';
import { CartStatusTracker, cartForRoom, cartStateFor, type CartSource } from './cart-status.js';

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
  parseLiveProductDeleteCurl,
  parseLiveProductPinCurl,
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
  productAddSender: ProductAddSender = sendLiveProductAdd,
  productSetStore?: ProductSetStore,
  autoLive?: AutoLiveManager,
  commentReplies?: CommentReplyService,
  chatBridge?: ChatBridge,
  boxphone?: BoxphoneService,
  productPins?: ProductPinStore,
  statsSources?: StatsSourceService,
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

  const cart = new CartStatusTracker();

  /** Remember what Live Hub just did to the live cart; TikTok cannot be asked for it later. */
  async function noteCart(
    ownerId: string,
    accountId: string | null,
    set: { name: string; productCount: number },
    outcome: 'accepted' | 'rejected' | 'unverified' | 'none',
    source: CartSource,
    options: { removing?: boolean; roomId?: string | null } = {},
  ) {
    const state = cartStateFor(outcome, options.removing);
    if (!state || !accountId) return;
    const roomId =
      options.roomId !== undefined
        ? options.roomId
        : liveService
          ? await liveService.currentRoomId(ownerId, accountId).catch(() => null)
          : null;
    cart.record(ownerId, accountId, {
      state,
      roomId,
      setName: set.name,
      productCount: set.productCount,
      source,
      at: new Date().toISOString(),
    });
  }

  if (commentReplies && accountConfig) {
    registerAiCommentRoutes(
      app,
      commentReplies,
      ownerFromHeaders,
      async (owner, id) => !!(await accountConfig.store.findEncrypted(owner, id)),
    );
  }
  if (chatBridge && accountConfig)
    registerChatBridgeRoutes(
      app,
      chatBridge,
      ownerFromHeaders,
      async (owner, id) => !!(await accountConfig.store.findEncrypted(owner, id)),
    );

  if (boxphone && accountConfig && liveService)
    registerBoxphoneRoutes(app, boxphone, liveService, ownerFromHeaders, (headers) =>
      tokenMatches(
        headers['x-internal-token'] as string | string[] | undefined,
        accountConfig.internalToken,
      ),
    );

  if (statsSources && accountConfig) registerStatsSourceRoutes(app, statsSources, ownerFromHeaders);

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
        if (!roomId && !input.parsed.cookieHeader)
          return reply
            .status(409)
            .send({ error: 'Save this as a product set and queue it before LIVE.' });
        const account = await accountConfig.store.findEncrypted(ownerId, input.accountId);
        if (!account) return reply.status(404).send({ error: 'Account not found.' });
        const cookieHeader =
          input.parsed.cookieHeader ??
          decryptAccountCookie(account, accountConfig.encryptionKey, ownerId, input.accountId);
        const outcome = await productAddSender(input.parsed, cookieHeader);
        const result = {
          outcome,
          roomId: roomId ?? input.parsed.roomId,
          productCount: input.parsed.productIds.length,
        };
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
    if (
      Object.keys(values).some((key) => !['name', 'curl', 'accountId', 'deleteCurl'].includes(key))
    )
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
    let deleteCurl: string | null | undefined;
    if (values.deleteCurl !== undefined) {
      if (values.deleteCurl === null || values.deleteCurl === '') deleteCurl = null;
      else if (typeof values.deleteCurl === 'string' && values.deleteCurl.length <= 100_000)
        deleteCurl = values.deleteCurl;
      else return null;
    }
    try {
      const parsed = parseLiveProductAddCurl(curl);
      if (!parsed.cookieHeader && !accountId) return null;
      const removalSource =
        deleteCurl === undefined
          ? ((previous as { deleteCurl?: string | null } | undefined)?.deleteCurl ?? null)
          : deleteCurl;
      if (removalSource) {
        // The remove request is signed for exactly these products, so it must match the set.
        const removal = parseLiveProductDeleteCurl(removalSource);
        const ids = new Set(parsed.productIds);
        if (
          removal.productIds.length !== ids.size ||
          removal.productIds.some((productId: string) => !ids.has(productId)) ||
          (!removal.cookieHeader && !accountId)
        )
          return null;
      }
      return {
        name: values.name.trim(),
        accountId,
        curl,
        ...(deleteCurl !== undefined ? { deleteCurl } : {}),
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

  async function sendSavedSetToRoom(ownerId: string, saved: ProductSetInput) {
    if (!accountConfig || !saved.accountId) throw new Error('A connected account is required.');
    const account = await accountConfig.store.findEncrypted(ownerId, saved.accountId);
    if (!account) throw new Error('Account not found.');
    const parsed = parseLiveProductAddCurl(saved.curl);
    // A copied Shop request can be signed over its body. Keep room_id and every
    // signed field unchanged; selecting an account only identifies the LIVE room.
    const cookieHeader =
      parsed.cookieHeader ??
      decryptAccountCookie(account, accountConfig.encryptionKey, ownerId, saved.accountId);
    return productAddSender(parsed, cookieHeader);
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

  app.get('/api/v1/live/product-sets/:id', async (request, reply) => {
    if (!productSetStore) return reply.status(503).send({ error: 'Product sets are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid product set ID.' });
    try {
      const saved = await productSetStore.find(ownerId, id);
      if (!saved) return reply.status(404).send({ error: 'Product set not found.' });
      return { item: saved };
    } catch {
      return reply.status(503).send({ error: 'Product set is unavailable.' });
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

  app.post('/api/v1/live/product-sets/:id/auto', async (request, reply) => {
    if (!productSetStore) return reply.status(503).send({ error: 'Product sets are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid product set ID.' });
    const body = request.body as { enabled?: unknown } | null;
    if (!body || typeof body !== 'object' || typeof body.enabled !== 'boolean')
      return reply.status(400).send({ error: 'enabled must be true or false.' });
    try {
      const result = await productSetStore.setAutoApply(ownerId, id, body.enabled);
      if (result === 'not-found')
        return reply.status(404).send({ error: 'Product set not found.' });
      if (result === 'no-account')
        return reply.status(409).send({ error: 'Link an account to this set first.' });
      return { id, autoApply: body.enabled };
    } catch {
      return reply.status(503).send({ error: 'Product set could not be updated.' });
    }
  });
  app.get('/api/v1/live/account-status', async (request, reply) => {
    if (!accountConfig || !liveService)
      return reply.status(503).send({ error: 'Account status is unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    try {
      const [accounts, sets] = await Promise.all([
        accountConfig.store.list(ownerId),
        productSetStore ? productSetStore.list(ownerId) : Promise.resolve([]),
      ]);
      const items = await Promise.all(
        accounts.map(async (account) => {
          const roomId = await liveService.currentRoomId(ownerId, account.id).catch(() => null);
          const record = cartForRoom(cart.get(ownerId, account.id), roomId);
          const auto = sets.find((set) => set.accountId === account.id && set.autoApply);
          const replies = commentReplies
            ? await commentReplies.state(ownerId, account.id).catch(() => null)
            : null;
          const rounds = autoLive
            ? await autoLive.get(ownerId, account.id).catch(() => null)
            : null;
          const lastReply = replies?.history.find((entry) => !entry.preview) ?? null;
          return {
            accountId: account.id,
            hasOpenRoom: roomId !== null,
            cart: record
              ? {
                  state: record.state,
                  setName: record.setName,
                  productCount: record.productCount,
                  source: record.source,
                  at: record.at,
                }
              : null,
            autoSet: auto ? { name: auto.name, productCount: auto.productIds.length } : null,
            ai: replies
              ? {
                  enabled: replies.settings.enabled,
                  aiReady: replies.aiReady,
                  chatConnected: replies.connection?.connected ?? replies.chatReady,
                  chatMessage: replies.connection?.message ?? '',
                  model: replies.settings.model,
                  answerWhen: replies.settings.answerWhen,
                  sentCount: replies.history.filter(
                    (entry) => !entry.preview && entry.status === 'sent',
                  ).length,
                  lastReply: lastReply
                    ? { status: lastReply.status, at: lastReply.createdAt }
                    : null,
                }
              : null,
            auto: rounds
              ? {
                  phase: rounds.phase,
                  phaseStartedAt: rounds.phaseStartedAt,
                  completedRounds: rounds.completedRounds,
                  lastError: rounds.lastError,
                  endAfterMinutes: rounds.settings.endAfterMinutes,
                  restartAfterMinutes: rounds.settings.restartAfterMinutes,
                  dailyStartTime: rounds.settings.dailyStartTime,
                  recoverStream: rounds.settings.recoverStream,
                  autoAddProducts: rounds.settings.autoAddProducts !== false,
                  autoPinProduct: rounds.settings.autoPinProduct === true,
                  videoCount: rounds.settings.videoRotation?.length ?? 0,
                  setCount: rounds.settings.productSetRotation?.length ?? 0,
                }
              : null,
          };
        }),
      );
      return { items };
    } catch {
      return reply.status(503).send({ error: 'Cart status is unavailable.' });
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
        const parsed = parseLiveProductAddCurl(saved.curl);
        if (!roomId && !parsed.cookieHeader) {
          return { outcome: 'queued', roomId: '', productCount: saved.productIds.length };
        }
        const outcome = await sendSavedSetToRoom(ownerId, saved);
        await noteCart(
          ownerId,
          saved.accountId,
          { name: saved.name, productCount: saved.productIds.length },
          outcome,
          'manual',
        );
        const result = {
          outcome,
          roomId: roomId ?? parsed.roomId,
          productCount: saved.productIds.length,
          queuedForLive: !roomId,
        };
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

  app.post('/api/v1/live/product-sets/:id/remove', async (request, reply) => {
    if (!productSetStore || !accountConfig)
      return reply.status(503).send({ error: 'Product sets are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid product set ID.' });
    try {
      const saved = await productSetStore.find(ownerId, id);
      if (!saved) return reply.status(404).send({ error: 'Product set not found.' });
      if (!saved.deleteCurl) {
        return reply.status(409).send({ error: 'This set has no remove request saved.' });
      }
      const parsed = parseLiveProductDeleteCurl(saved.deleteCurl);
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
      await noteCart(
        ownerId,
        saved.accountId,
        { name: saved.name, productCount: parsed.productIds.length },
        outcome,
        'manual',
        { removing: true },
      );
      const result = { outcome, productCount: parsed.productIds.length };
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

  app.post('/api/v1/accounts/:id/session', { bodyLimit: 70_000 }, async (request, reply) => {
    if (!accountConfig) return reply.status(503).send({ error: 'Account import is unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id?: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid account ID.' });
    const body = request.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['curl', 'sessionid'].includes(key))
    ) {
      return reply.status(400).send({ error: 'Invalid session request.' });
    }
    const values = body as Record<string, unknown>;
    if ((typeof values.curl === 'string') === (typeof values.sessionid === 'string')) {
      return reply.status(400).send({ error: 'Invalid session request.' });
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
        return reply.status(400).send({ error: 'Invalid session cURL.' });
      }
      try {
        parsed = parseAccountImportCurl(values.curl);
      } catch {
        return reply.status(400).send({ error: 'Invalid session cURL.' });
      }
    }
    try {
      if (!(await accountConfig.store.findEncrypted(ownerId, id))) {
        return reply.status(404).send({ error: 'Account not found.' });
      }
      const identity = await (accountConfig.identityLookup ?? lookupTikTokIdentity)(
        parsed.cookieHeader,
        parsed.userAgent,
      );
      if (!identity) {
        return reply.status(422).send({ error: 'TikTok session is not authenticated.' });
      }
      // A card keeps its live settings, so it must not be pointed at a different TikTok account.
      const known = await accountConfig.store.getVerifiedUserId(ownerId, id);
      if (known && known !== identity.userId) {
        return reply.status(409).send({ error: 'Session belongs to a different TikTok account.' });
      }
      const item = await accountConfig.store.updateSession(
        ownerId,
        id,
        {
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
        },
        parsed.claimedHandle,
        identity,
      );
      if (!item) return reply.status(404).send({ error: 'Account not found.' });
      return { item };
    } catch {
      return reply.status(503).send({ error: 'TikTok account check is unavailable.' });
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

  const avatarHost =
    /(^|\.)(tiktokcdn[a-z-]*\.com|tiktok\.com|ibyteimg\.com|byteimg\.com|tiktokv\.com)$/i;

  async function downloadAvatar(url: string | undefined) {
    if (!url) return null;
    try {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !avatarHost.test(target.hostname)) return null;
      const response = await fetch(target, {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      });
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.startsWith('image/')) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length > 0 && bytes.length <= 2_000_000 ? { bytes, type } : null;
    } catch {
      return null;
    }
  }

  app.get('/api/v1/accounts/:id/avatar', async (request, reply) => {
    if (!accountConfig) return reply.status(503).send({ error: 'Account checks are unavailable.' });
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { id } = request.params as { id?: string };
    if (!validAccountId(id)) return reply.status(400).send({ error: 'Invalid account ID.' });
    try {
      const current = (await accountConfig.store.list(ownerId)).find((item) => item.id === id);
      if (!current) return reply.status(404).send({ error: 'Account not found.' });
      const stale =
        !current.avatarUrl ||
        !current.verifiedAt ||
        Date.now() - Date.parse(current.verifiedAt) > 60 * 60 * 1000;
      let avatarUrl = current.avatarUrl;
      let image = stale ? null : await downloadAvatar(avatarUrl);
      if (!image) {
        // Avatar links from TikTok expire, so re-read the profile picture from the account itself.
        try {
          const encrypted = await accountConfig.store.findEncrypted(ownerId, id);
          if (encrypted) {
            const cookieHeader = decryptAccountCookie(
              encrypted,
              accountConfig.encryptionKey,
              ownerId,
              id,
            );
            const userAgent = encrypted.userAgent
              ? decryptAccountUserAgent(
                  encrypted.userAgent,
                  accountConfig.encryptionKey,
                  ownerId,
                  id,
                )
              : undefined;
            const identity = await (accountConfig.identityLookup ?? lookupTikTokIdentity)(
              cookieHeader,
              userAgent,
            );
            if (identity) {
              await accountConfig.store.setVerification(ownerId, id, identity);
              avatarUrl = identity.avatarUrl;
            }
          }
        } catch {
          // Keep whatever picture is already stored.
        }
        image = await downloadAvatar(avatarUrl);
        if (!image && stale) image = await downloadAvatar(current.avatarUrl);
      }
      if (!image) return reply.status(404).send({ error: 'No profile picture available.' });
      return reply
        .header('content-type', image.type)
        .header('cache-control', 'private, max-age=600')
        .send(image.bytes);
    } catch {
      return reply.status(503).send({ error: 'Account storage is unavailable.' });
    }
  });

  if (liveService) {
    if (accountConfig && productSetStore) {
      app.post(
        '/api/v1/live/sessions/:accountId/pin-product',
        { bodyLimit: 1024 },
        async (request, reply) => {
          const owner = ownerFromHeaders(request.headers);
          if (!owner) return reply.status(401).send({ error: 'Unauthorized.' });
          const { accountId } = request.params as { accountId: string };
          const body = request.body as { setId?: unknown; productId?: unknown };
          if (
            !validAccountId(accountId) ||
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).some((k) => !['setId', 'productId'].includes(k)) ||
            typeof body.setId !== 'string' ||
            !validAccountId(body.setId) ||
            typeof body.productId !== 'string' ||
            !/^\d{8,24}$/.test(body.productId)
          )
            return reply.status(400).send({ error: 'Invalid product selection.' });
          try {
            const outcome = await pinSelectedProduct(
              productSetStore,
              accountConfig,
              liveService,
              productAddSender,
              owner,
              accountId,
              body.setId,
              body.productId,
            );
            return { outcome };
          } catch (e) {
            if (e instanceof LiveError)
              return reply.status(e.statusCode).send({ error: e.message });
            return reply.status(503).send({ error: 'ไม่ยืนยันผลปักหมุด กรุณาตรวจใน TikTok Shop' });
          }
        },
      );
    }
    if (productPins && accountConfig) {
      app.get('/api/v1/live/sessions/:accountId/product-pin', async (request, reply) => {
        const owner = ownerFromHeaders(request.headers);
        if (!owner) return reply.status(401).send({ error: 'Unauthorized.' });
        const { accountId } = request.params as { accountId: string };
        if (!validAccountId(accountId))
          return reply.status(400).send({ error: 'Invalid account ID.' });
        if (!(await accountConfig.store.findEncrypted(owner, accountId)))
          return reply.status(404).send({ error: 'Account not found.' });
        return { hasRequest: await productPins.has(owner, accountId) };
      });
      app.put(
        '/api/v1/live/sessions/:accountId/product-pin',
        { bodyLimit: 110000 },
        async (request, reply) => {
          const owner = ownerFromHeaders(request.headers);
          if (!owner) return reply.status(401).send({ error: 'Unauthorized.' });
          const { accountId } = request.params as { accountId: string };
          if (!validAccountId(accountId))
            return reply.status(400).send({ error: 'Invalid account ID.' });
          const secret = await accountConfig.store.findEncrypted(owner, accountId);
          if (!secret) return reply.status(404).send({ error: 'Account not found.' });
          const values = request.body as { curl?: unknown };
          if (
            !values ||
            typeof values !== 'object' ||
            Array.isArray(values) ||
            Object.keys(values).some((k) => k !== 'curl') ||
            !(
              values.curl === null ||
              (typeof values.curl === 'string' &&
                values.curl.length > 0 &&
                values.curl.length <= 100000)
            )
          )
            return reply.status(400).send({ error: 'Invalid pin request.' });
          try {
            if (typeof values.curl === 'string') {
              const parsed = parseLiveProductPinCurl(values.curl);
              if (parsed.cookieHeader) {
                const savedCookie = decryptAccountCookie(
                  secret,
                  accountConfig.encryptionKey,
                  owner,
                  accountId,
                );
                const sid = (cookie: string) =>
                  /(?:^|;\s*)sessionid=([^;]+)/.exec(cookie)?.[1] ??
                  /(?:^|;\s*)sid_tt=([^;]+)/.exec(cookie)?.[1];
                if (!sid(savedCookie) || sid(parsed.cookieHeader) !== sid(savedCookie))
                  return reply.status(409).send({
                    error: 'Cookie ปักหมุดไม่ตรงกับ session บัญชีนี้ กรุณาอัปเดต session ให้ตรงกัน',
                  });
              }
            }
            await productPins.save(owner, accountId, values.curl as string | null);
            return { hasRequest: await productPins.has(owner, accountId) };
          } catch {
            return reply.status(400).send({
              error: 'cURL ปักหมุดไม่ถูกต้อง ต้องเป็นคำขอ Pin/Explain สินค้าจริงใน TikTok Shop',
            });
          }
        },
      );
      if (autoLive && productSetStore) {
        const store = productSetStore;
        const actions = createRoundProductActions(
          store,
          productPins,
          accountConfig,
          liveService,
          productAddSender,
        );
        const beforeStream = actions.beforeStream.bind(actions);
        actions.beforeStream = async (owner, account, room, plan) => {
          const outcome = await beforeStream(owner, account, room, plan);
          try {
            const id =
              plan.productSetId ??
              (await store.list(owner)).find((s) => s.accountId === account && s.autoApply)?.id;
            const set = id ? await store.find(owner, id) : null;
            if (set)
              await noteCart(
                owner,
                account,
                { name: set.name, productCount: set.productIds.length },
                outcome,
                'round',
                { roomId: room },
              );
          } catch {
            // The cart note is informational and must never fail a round.
          }
          return outcome;
        };
        autoLive.setRoundActions(actions);
      }
    }
    const onRoomStarted = async (ownerId: string, accountId: string) => {
      if (!productSetStore || !accountConfig) return 'none';
      const sets = await productSetStore.list(ownerId);
      const selected = sets.find((item) => item.accountId === accountId && item.autoApply);
      if (!selected) return 'none';
      const saved = await productSetStore.find(ownerId, selected.id);
      if (!saved) return 'none';
      try {
        const outcome = await sendSavedSetToRoom(ownerId, saved);
        await noteCart(
          ownerId,
          accountId,
          { name: saved.name, productCount: saved.productIds.length },
          outcome,
          'live-start',
        );
        return outcome;
      } catch {
        return 'unverified';
      }
    };
    registerLiveRoutes(app, liveService, ownerFromHeaders, onRoomStarted, autoLive);
    autoLive?.setOnRoomStarted(onRoomStarted);
  }

  return app;
}
