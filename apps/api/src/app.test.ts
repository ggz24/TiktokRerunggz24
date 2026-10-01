import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.js';
import {
  decryptAccountCookie,
  decryptAccountUserAgent,
  lookupTikTokIdentity,
  type AccountMetadata,
  type IdentityLookup,
  type StoredAccount,
} from './accounts.js';
import type { ProductSetInput, ProductSetItem, ProductSetStore } from './product-set-store.js';
import type { LiveService } from './live-service.js';

test('health reports dependencies ready when all checks succeed', async () => {
  const app = createApp({
    postgres: async () => {},
    redis: async () => {},
    worker: async () => true,
  });
  const result = await app.inject('/health/ready');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().dependencies, {
    postgres: 'ready',
    redis: 'ready',
    worker: 'ready',
  });
  await app.close();
});

test('health reports degraded without leaking connection errors', async () => {
  const app = createApp({
    postgres: async () => {
      throw new Error('private URL');
    },
    redis: async () => {},
    worker: async () => false,
  });
  const result = await app.inject('/health/ready');
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().status, 'degraded');
  assert.equal(result.body.includes('private URL'), false);
  await app.close();
});

test('mock stats map into a validated shared event', async () => {
  const app = createApp({
    postgres: async () => {},
    redis: async () => {},
    worker: async () => true,
  });
  const result = await app.inject('/api/v1/mock/live-stats');
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().source, 'mock');
  assert.equal(result.json().verification.status, 'pending_verification');
  assert.equal(result.json().event.eventType, 'stats.updated');
  assert.equal(result.json().contract, 'valid');
  await app.close();
});

const syntheticCurl =
  "curl 'https://www.tiktok.com/api/update/profile/' -X HEAD " +
  "-b 'sessionid=fake-session-only' " +
  "-H 'referer: https://www.tiktok.com/@sample.user' " +
  "-H 'user-agent: Synthetic Test Browser'";
const headers = {
  'x-internal-token': 'synthetic-internal-token-1234567890123456',
  'x-livehub-owner': 'owner-1',
};

function metadata(row: StoredAccount): AccountMetadata {
  return {
    id: row.id,
    alias: row.alias,
    liveTitle: row.liveTitle,
    ...(row.claimedHandle === undefined ? {} : { claimedHandle: row.claimedHandle }),
    ...(row.verifiedHandle === undefined ? {} : { verifiedHandle: row.verifiedHandle }),
    ...(row.avatarUrl === undefined ? {} : { avatarUrl: row.avatarUrl }),
    ...(row.verifiedAt === undefined ? {} : { verifiedAt: row.verifiedAt }),
    verificationStatus: row.verificationStatus,
    probe: row.probe,
    probeHttpStatus: row.probeHttpStatus,
    createdAt: row.createdAt,
  };
}

function accountFixture(identityLookup: IdentityLookup) {
  const rows: StoredAccount[] = [];
  const key = Buffer.alloc(32, 7);
  const config = {
    encryptionKey: key,
    internalToken: headers['x-internal-token'],
    identityLookup,
    store: {
      list: async (ownerId: string) => rows.filter((row) => row.ownerId === ownerId).map(metadata),
      insert: async (row: StoredAccount) => {
        rows.push(row);
        return metadata(row);
      },
      updateSettings: async (
        ownerId: string,
        id: string,
        settings: { alias: string; liveTitle: string },
      ) => {
        const row = rows.find((item) => item.ownerId === ownerId && item.id === id);
        if (!row) return null;
        row.alias = settings.alias;
        row.liveTitle = settings.liveTitle;
        return metadata(row);
      },
      delete: async (ownerId: string, id: string) => {
        const index = rows.findIndex((item) => item.ownerId === ownerId && item.id === id);
        if (index < 0) return false;
        rows.splice(index, 1);
        return true;
      },
      findEncrypted: async (ownerId: string, id: string) => {
        const row = rows.find((item) => item.ownerId === ownerId && item.id === id);
        if (!row) return null;
        return {
          id: row.id,
          ownerId: row.ownerId,
          ciphertext: row.ciphertext,
          iv: row.iv,
          tag: row.tag,
          ...(row.userAgent ? { userAgent: row.userAgent } : {}),
        };
      },
      getVerifiedUserId: async (ownerId: string, id: string) =>
        rows.find((item) => item.ownerId === ownerId && item.id === id)?.verifiedUserId ?? null,
      updateSession: async (
        ownerId: string,
        id: string,
        session: Pick<StoredAccount, 'ciphertext' | 'iv' | 'tag' | 'userAgent'>,
        claimedHandle: string | undefined,
        identity: NonNullable<Awaited<ReturnType<IdentityLookup>>>,
      ) => {
        const row = rows.find((item) => item.ownerId === ownerId && item.id === id);
        if (!row) return null;
        row.ciphertext = session.ciphertext;
        row.iv = session.iv;
        row.tag = session.tag;
        row.userAgent = session.userAgent;
        if (claimedHandle) row.claimedHandle = claimedHandle;
        row.verificationStatus = 'connected';
        row.verifiedAt = new Date().toISOString();
        row.verifiedHandle = identity.username;
        row.verifiedUserId = identity.userId;
        row.avatarUrl = identity.avatarUrl;
        return metadata(row);
      },
      setVerification: async (
        ownerId: string,
        id: string,
        identity: Awaited<ReturnType<IdentityLookup>>,
      ) => {
        const row = rows.find((item) => item.ownerId === ownerId && item.id === id);
        if (!row) return null;
        row.verificationStatus = identity ? 'connected' : 'disconnected';
        if (identity) {
          row.verifiedAt = new Date().toISOString();
          row.verifiedHandle = identity.username;
          row.verifiedUserId = identity.userId;
          row.avatarUrl = identity.avatarUrl;
        } else {
          row.verifiedAt = undefined;
          row.verifiedHandle = undefined;
          row.avatarUrl = undefined;
        }
        return metadata(row);
      },
    },
  };
  return { rows, key, config };
}

const productBody = JSON.stringify({
  room_id: '7681699623552076564',
  product_info: [{ product_id: '1732490821698225758', product_type: 4 }],
  need_product_info: true,
});
const productCurl =
  "curl --url 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/add?msToken=test' " +
  "-H 'Content-Type: application/json' --data-raw '" +
  productBody +
  "'";

test('product cURL preview is authenticated, scoped, and omits signed values', async () => {
  const fixture = accountFixture(async () => null);
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/v1/live/products/preview',
    payload: { curl: productCurl },
  });
  assert.equal(unauthorized.statusCode, 401);
  const preview = await app.inject({
    method: 'POST',
    url: '/api/v1/live/products/preview',
    headers,
    payload: { curl: productCurl },
  });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.json(), {
    roomId: '7681699623552076564',
    productIds: ['1732490821698225758'],
    hasCookie: false,
  });
  assert.equal(preview.body.includes('msToken'), false);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/live/products/preview',
    headers,
    payload: { curl: productCurl.replace('shop.tiktok.com', 'example.com') },
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

test('product add uses the selected encrypted account session only after an explicit send', async () => {
  const fixture = accountFixture(async () => ({
    userId: '1234567890123456789',
    username: 'sample.user',
  }));
  let sends = 0;
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
    undefined,
    async (parsed, cookie) => {
      sends += 1;
      assert.equal(parsed.roomId, '7681699623552076564');
      assert.equal(cookie, 'sessionid=fake-session-only');
      return 'accepted';
    },
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  assert.equal(imported.statusCode, 201);
  const accountId = imported.json().item.id;
  const preview = await app.inject({
    method: 'POST',
    url: '/api/v1/live/products/preview',
    headers,
    payload: { curl: productCurl, accountId },
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(sends, 0);
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/live/products/add',
    headers,
    payload: { curl: productCurl, accountId },
  });
  assert.equal(sent.statusCode, 200);
  assert.deepEqual(sent.json(), {
    outcome: 'accepted',
    roomId: '7681699623552076564',
    productCount: 1,
  });
  assert.equal(sends, 1);
  await app.close();
});

test('named product sets stay owner-scoped and only send after the explicit action', async () => {
  const fixture = accountFixture(async () => null);
  const records: Array<
    ProductSetItem & { ownerId: string; curl: string; deleteCurl: string | null }
  > = [];
  const setId = '11111111-1111-4111-8111-111111111111';
  const now = '2026-09-29T00:00:00.000Z';
  const publicItem = (row: ProductSetItem): ProductSetItem => ({
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    roomId: row.roomId,
    productIds: row.productIds,
    hasCookie: row.hasCookie,
    hasDelete: row.hasDelete,
    autoApply: row.autoApply,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const store: ProductSetStore = {
    list: async (ownerId) => records.filter((item) => item.ownerId === ownerId).map(publicItem),
    find: async (ownerId, id) =>
      records.find((item) => item.ownerId === ownerId && item.id === id) ?? null,
    create: async (ownerId, input: ProductSetInput) => {
      const item = {
        id: setId,
        ownerId,
        ...input,
        hasDelete: Boolean(input.deleteCurl),
        deleteCurl: input.deleteCurl ?? null,
        autoApply: false,
        createdAt: now,
        updatedAt: now,
      };
      records.push(item);
      return publicItem(item);
    },
    update: async (ownerId, id, input) => {
      const item = records.find((row) => row.ownerId === ownerId && row.id === id);
      if (!item) return null;
      Object.assign(
        item,
        input,
        input.deleteCurl !== undefined
          ? { hasDelete: Boolean(input.deleteCurl), deleteCurl: input.deleteCurl }
          : {},
      );
      return publicItem(item);
    },
    delete: async (ownerId, id) => {
      const index = records.findIndex((item) => item.ownerId === ownerId && item.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
    selectForLive: async (ownerId, id) => {
      const selected = records.find((item) => item.ownerId === ownerId && item.id === id);
      if (!selected?.accountId) return;
      for (const item of records) {
        if (item.ownerId === ownerId && item.accountId === selected.accountId) {
          item.autoApply = item.id === id;
        }
      }
    },
  };
  let sends = 0;
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
    undefined,
    async (_parsed, cookie) => {
      sends += 1;
      assert.equal(cookie, 'sessionid=product-test');
      return 'accepted';
    },
    store,
  );
  const savedCurl = `${productCurl} -b 'sessionid=product-test'`;
  const createPayload = { name: 'ชุดสินค้าเช้า', curl: savedCurl, accountId: null };
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/v1/live/product-sets', payload: createPayload }))
      .statusCode,
    401,
  );
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/live/product-sets',
    headers,
    payload: createPayload,
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().item.name, createPayload.name);
  assert.equal(created.body.includes('sessionid'), false);
  assert.equal(created.body.includes('msToken'), false);
  assert.equal(sends, 0);
  const listed = await app.inject({ method: 'GET', url: '/api/v1/live/product-sets', headers });
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.body.includes('sessionid'), false);
  const otherHeaders = { ...headers, 'x-livehub-owner': 'owner-2' };
  const detailUrl = `/api/v1/live/product-sets/${setId}`;
  assert.equal((await app.inject({ method: 'GET', url: detailUrl })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'GET', url: detailUrl, headers: otherHeaders })).statusCode,
    404,
  );
  const detail = await app.inject({ method: 'GET', url: detailUrl, headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().item.curl, savedCurl);
  assert.equal(detail.json().item.deleteCurl, null);
  assert.equal(
    (
      await app.inject({ method: 'GET', url: '/api/v1/live/product-sets', headers: otherHeaders })
    ).json().items.length,
    0,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/live/product-sets/${setId}/send`,
        headers: otherHeaders,
      })
    ).statusCode,
    404,
  );
  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/v1/live/product-sets/${setId}`,
    headers,
    payload: { name: 'ชุดสินค้าใหม่' },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().item.name, 'ชุดสินค้าใหม่');
  assert.equal(sends, 0);
  const sent = await app.inject({
    method: 'POST',
    url: `/api/v1/live/product-sets/${setId}/send`,
    headers,
  });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json().outcome, 'accepted');
  assert.equal(sends, 1);
  const removeUrl = `/api/v1/live/product-sets/${setId}/remove`;
  assert.equal((await app.inject({ method: 'POST', url: removeUrl, headers })).statusCode, 409);
  const deleteCurl = (ids: string[]) =>
    "curl --url 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/delete?msToken=test' " +
    "-H 'Content-Type: application/json' -b 'sessionid=product-test' --data-raw '" +
    JSON.stringify({ product_ids: ids, promotion_ids: [], product_to_parent_id: {} }) +
    "'";
  const mismatched = await app.inject({
    method: 'PATCH',
    url: `/api/v1/live/product-sets/${setId}`,
    headers,
    payload: { name: 'ชุดสินค้าใหม่', deleteCurl: deleteCurl(['1732490821698225999']) },
  });
  assert.equal(mismatched.statusCode, 400);
  const withRemoval = await app.inject({
    method: 'PATCH',
    url: `/api/v1/live/product-sets/${setId}`,
    headers,
    payload: { name: 'ชุดสินค้าใหม่', deleteCurl: deleteCurl(['1732490821698225758']) },
  });
  assert.equal(withRemoval.statusCode, 200);
  assert.equal(withRemoval.json().item.hasDelete, true);
  assert.equal(withRemoval.body.includes('sessionid'), false);
  assert.equal(
    (await app.inject({ method: 'POST', url: removeUrl, headers: otherHeaders })).statusCode,
    404,
  );
  const removed = await app.inject({ method: 'POST', url: removeUrl, headers });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), { outcome: 'accepted', productCount: 1 });
  assert.equal(sends, 2);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/live/product-sets/${setId}`,
        headers: otherHeaders,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/v1/live/product-sets/${setId}`, headers }))
      .statusCode,
    204,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/v1/live/product-sets', headers })).json().items
      .length,
    0,
  );
  await app.close();
});

test('a saved set uses the captured Shop request unchanged when linked to a LIVE account', async () => {
  const fixture = accountFixture(async () => ({
    userId: '1234567890123456789',
    username: 'sample.user',
  }));
  const setId = '11111111-1111-4111-8111-111111111111';
  const roomId = '7690886057457437492';
  let currentRoomId: string | null = null;
  const state: { saved?: ProductSetItem & { curl: string; deleteCurl: string | null } } = {};
  const store: ProductSetStore = {
    list: async () => (state.saved ? [state.saved] : []),
    find: async (_owner, id) => (id === setId ? (state.saved ?? null) : null),
    create: async () => {
      throw new Error('not used');
    },
    update: async () => null,
    delete: async () => false,
    selectForLive: async () => {
      if (state.saved) state.saved.autoApply = true;
    },
  };
  const service = {
    currentRoomId: async () => currentRoomId,
    startAuto: async () => ({
      roomId,
      session: {
        accountId: state.saved?.accountId,
        status: 'starting',
        hasRtmpConfig: true,
        hasOpenRoom: true,
      },
    }),
    stopAll: async () => {},
  } as unknown as LiveService;
  let sends = 0;
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
    service,
    async (parsed, cookie) => {
      sends++;
      assert.equal(parsed.roomId, '');
      assert.equal(JSON.parse(parsed.body).room_id, '');
      assert.equal(cookie, 'sessionid=shop-session; oec_lucifer=shop-only');
      return 'accepted';
    },
    store,
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  assert.equal(imported.statusCode, 201);
  const accountId = imported.json().item.id;
  state.saved = {
    id: setId,
    name: 'Saved set',
    accountId,
    roomId: '',
    productIds: ['1732490821698225758'],
    hasCookie: true,
    hasDelete: false,
    deleteCurl: null,
    autoApply: false,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    curl: `${productCurl.replace('7681699623552076564', '')} -b 'sessionid=shop-session; oec_lucifer=shop-only'`,
  };
  const sendUrl = `/api/v1/live/product-sets/${setId}/send`;
  const queued = await app.inject({ method: 'POST', url: sendUrl, headers });
  assert.equal(queued.statusCode, 200);
  assert.equal(queued.json().outcome, 'accepted');
  assert.equal(queued.json().queuedForLive, true);
  assert.equal(state.saved.autoApply, true);
  assert.equal(sends, 1);
  const beforeLive = await app.inject({
    method: 'POST',
    url: '/api/v1/live/products/add',
    headers,
    payload: { curl: state.saved.curl, accountId },
  });
  assert.equal(beforeLive.statusCode, 200);
  assert.equal(sends, 2);
  currentRoomId = roomId;
  const sent = await app.inject({ method: 'POST', url: sendUrl, headers });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json().roomId, roomId);
  assert.equal(sends, 3);
  const direct = await app.inject({
    method: 'POST',
    url: '/api/v1/live/products/add',
    headers,
    payload: { curl: state.saved.curl, accountId },
  });
  assert.equal(direct.statusCode, 200);
  assert.equal(sends, 4);
  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/live/sessions/${accountId}/start-auto`,
    headers,
    payload: { title: 'Test' },
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().productsOutcome, 'accepted');
  assert.equal(sends, 5);
  await app.close();
});

test('account routes require internal token and authenticated owner header', async () => {
  const fixture = accountFixture(async () => null);
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  assert.equal((await app.inject('/api/v1/accounts')).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/accounts',
        headers: {
          ...headers,
          'x-internal-token': 'wrong',
        },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/accounts/import',
        headers: {
          'x-internal-token': headers['x-internal-token'],
        },
        payload: { alias: 'Sample', curl: syntheticCurl },
      })
    ).statusCode,
    401,
  );
  assert.equal(fixture.rows.length, 0);
  await app.close();

  const unconfigured = createApp({
    postgres: async () => {},
    redis: async () => {},
    worker: async () => true,
  });
  assert.equal((await unconfigured.inject('/api/v1/accounts')).statusCode, 503);
  await unconfigured.close();
});

test('authenticated identity connects the account and stores only encrypted cookie', async () => {
  const fixture = accountFixture(async (cookieHeader, userAgent) => {
    assert.equal(cookieHeader, 'sessionid=fake-session-only');
    assert.equal(userAgent, 'Synthetic Test Browser');
    return {
      userId: '1234567890123456789',
      username: 'sample.user',
      avatarUrl: 'https://cdn.example/avatar',
    };
  });
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: '  Sample Account  ', curl: syntheticCurl },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().item, {
    id: fixture.rows[0].id,
    alias: 'Sample Account',
    liveTitle: '',
    claimedHandle: 'sample.user',
    verifiedHandle: 'sample.user',
    avatarUrl: 'https://cdn.example/avatar',
    verifiedAt: fixture.rows[0].verifiedAt,
    verificationStatus: 'connected',
    probe: 'not_run',
    probeHttpStatus: null,
    createdAt: fixture.rows[0].createdAt,
  });
  assert.equal(response.body.includes('fake-session-only'), false);
  assert.equal(response.body.includes('curl'), false);
  assert.equal(fixture.rows[0].ciphertext.includes(Buffer.from('fake-session-only')), false);
  assert.equal(fixture.rows[0].iv.length, 12);
  assert.equal(fixture.rows[0].tag.length, 16);
  assert.ok(fixture.rows[0].userAgent);
  assert.equal(
    fixture.rows[0].userAgent?.ciphertext.includes(Buffer.from('Synthetic Test Browser')),
    false,
  );

  assert.equal(
    decryptAccountCookie(fixture.rows[0], fixture.key, 'owner-1', fixture.rows[0].id),
    'sessionid=fake-session-only',
  );
  assert.equal(
    decryptAccountUserAgent(fixture.rows[0].userAgent!, fixture.key, 'owner-1', fixture.rows[0].id),
    'Synthetic Test Browser',
  );

  const list = await app.inject({ method: 'GET', url: '/api/v1/accounts', headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);
  assert.equal(list.body.includes('fake-session-only'), false);
  const otherOwner = await app.inject({
    method: 'GET',
    url: '/api/v1/accounts',
    headers: {
      ...headers,
      'x-livehub-owner': 'owner-2',
    },
  });
  assert.deepEqual(otherOwner.json(), { items: [] });
  await app.close();
});

test('imports a sessionid and live title without retaining plaintext in the response', async () => {
  const sessionid = '1234567890abcdef1234567890abcdef';
  const fixture = accountFixture(async (cookieHeader) => {
    assert.equal(cookieHeader, `sessionid=${sessionid}`);
    return { userId: '1234567890123456789', username: 'sample.user' };
  });
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Jake style', sessionid, liveTitle: 'Live from MP4' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().item.liveTitle, 'Live from MP4');
  assert.equal(response.body.includes(sessionid), false);
  assert.equal(
    decryptAccountCookie(fixture.rows[0], fixture.key, 'owner-1', fixture.rows[0].id),
    `sessionid=${sessionid}`,
  );
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Bad', sessionid: 'short' },
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

test('invalid cURL and unavailable identity never create a connected account', async () => {
  const fixture = accountFixture(async () => {
    throw new Error('fake-private-session-value');
  });
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Bad', curl: syntheticCurl.replace('-X HEAD', '-X POST') },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.includes('fake-session-only'), false);
  assert.equal(fixture.rows.length, 0);

  const unavailable = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.includes('fake-private-session-value'), false);
  assert.equal(fixture.rows.length, 0);
  await app.close();

  const unauthenticated = accountFixture(async () => null);
  const second = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    unauthenticated.config,
  );
  const response = await second.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(unauthenticated.rows.length, 0);
  await second.close();
});

test('recheck uses the encrypted cookie and original User-Agent, then clears stale identity', async () => {
  let active = true;
  const fixture = accountFixture(async (cookieHeader, userAgent) => {
    assert.equal(cookieHeader, 'sessionid=fake-session-only');
    assert.equal(userAgent, 'Synthetic Test Browser');
    return active
      ? {
          userId: '1234567890123456789',
          username: 'sample.user',
          avatarUrl: 'https://cdn.example/avatar',
        }
      : null;
  });
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  const id = imported.json().item.id as string;
  assert.equal(imported.statusCode, 201);
  const verifyUrl = `/api/v1/accounts/${id}/verify`;
  assert.equal((await app.inject({ method: 'POST', url: verifyUrl })).statusCode, 401);
  active = false;
  const result = await app.inject({ method: 'POST', url: verifyUrl, headers });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().item.verificationStatus, 'disconnected');
  assert.equal(result.json().item.verifiedHandle, undefined);
  assert.equal(result.json().item.avatarUrl, undefined);
  assert.equal(result.json().item.verifiedAt, undefined);
  assert.equal(result.body.includes('fake-session-only'), false);
  await app.close();
});

test('account settings update is validated and scoped to the owner', async () => {
  const fixture = accountFixture(async () => ({
    userId: '1234567890123456789',
    username: 'sample.user',
  }));
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  const id = imported.json().item.id as string;
  const url = `/api/v1/accounts/${id}`;
  const originalCiphertext = Buffer.from(fixture.rows[0].ciphertext);
  const originalIv = Buffer.from(fixture.rows[0].iv);

  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url,
        payload: { alias: 'Updated', liveTitle: 'Session' },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url,
        headers: { ...headers, 'x-livehub-owner': 'owner-2' },
        payload: { alias: 'Updated', liveTitle: 'Session' },
      })
    ).statusCode,
    404,
  );
  for (const payload of [
    { alias: '', liveTitle: 'Session' },
    { alias: 'Updated' },
    { alias: 'Updated', liveTitle: 'x'.repeat(121) },
    { alias: 'Updated', liveTitle: 'bad\nvalue' },
    { alias: 'Updated', liveTitle: '', unexpected: true },
  ]) {
    assert.equal((await app.inject({ method: 'PATCH', url, headers, payload })).statusCode, 400);
  }
  assert.equal(fixture.rows[0].alias, 'Sample');
  assert.equal(fixture.rows[0].liveTitle, '');

  const result = await app.inject({
    method: 'PATCH',
    url,
    headers,
    payload: { alias: '  Updated  ', liveTitle: '  Evening live  ' },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().item.alias, 'Updated');
  assert.equal(result.json().item.liveTitle, 'Evening live');
  assert.equal(result.body.includes('fake-session-only'), false);
  assert.deepEqual(fixture.rows[0].ciphertext, originalCiphertext);
  assert.deepEqual(fixture.rows[0].iv, originalIv);
  const cleared = await app.inject({
    method: 'PATCH',
    url,
    headers,
    payload: { alias: 'Updated', liveTitle: '' },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().item.liveTitle, '');
  await app.close();
});

test('deleting an account removes its encrypted session only for the owner', async () => {
  const fixture = accountFixture(async () => ({
    userId: '1234567890123456789',
    username: 'sample.user',
  }));
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  const id = imported.json().item.id as string;
  const url = `/api/v1/accounts/${id}`;

  assert.equal((await app.inject({ method: 'DELETE', url })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers: { ...headers, 'x-livehub-owner': 'owner-2' },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'DELETE', url: '/api/v1/accounts/bad', headers })).statusCode,
    400,
  );
  assert.equal(fixture.rows.length, 1);

  const deleted = await app.inject({ method: 'DELETE', url, headers });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, '');
  assert.equal(fixture.rows.length, 0);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/accounts', headers })).json(), {
    items: [],
  });
  assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 404);
  assert.equal(
    (await app.inject({ method: 'POST', url: `${url}/verify`, headers })).statusCode,
    404,
  );
  await app.close();
});

test('identity lookup accepts a successful numeric error_code of zero', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          error_code: 0,
          user_id_str: '1234567890123456789',
          username: 'sample.user',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  try {
    assert.deepEqual(await lookupTikTokIdentity('sessionid=fake-session'), {
      userId: '1234567890123456789',
      username: 'sample.user',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('profile picture is served through the API and refreshed when the stored link has expired', async () => {
  const fresh = 'https://p16-sign-sg.tiktokcdn.com/fresh.jpeg';
  const expired = 'https://p16-sign-sg.tiktokcdn.com/expired.jpeg';
  const fixture = accountFixture(async () => ({
    userId: '1234567890123456789',
    username: 'sample.user',
    avatarUrl: fresh,
  }));
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  const accountId = imported.json().item.id as string;
  fixture.rows[0].avatarUrl = expired;
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    return url === fresh
      ? new Response(Buffer.from('image-bytes'), { headers: { 'content-type': 'image/jpeg' } })
      : new Response('gone', { status: 403 });
  }) as typeof fetch;
  try {
    const url = `/api/v1/accounts/${accountId}/avatar`;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'GET', url, headers: { ...headers, 'x-livehub-owner': 'x2' } }))
        .statusCode,
      404,
    );
    const picture = await app.inject({ method: 'GET', url, headers });
    assert.equal(picture.statusCode, 200);
    assert.equal(picture.headers['content-type'], 'image/jpeg');
    assert.equal(picture.body, 'image-bytes');
    assert.equal(fixture.rows[0].avatarUrl, fresh);
    assert.ok(requested.includes(fresh));
    // A stored link on a host that is not a TikTok image CDN is never fetched.
    fixture.rows[0].avatarUrl = 'https://internal.example/secret.png';
    requested.length = 0;
    fixture.config.identityLookup = async () => null;
    const blocked = await app.inject({ method: 'GET', url, headers });
    assert.equal(blocked.statusCode, 404);
    assert.equal(requested.includes('https://internal.example/secret.png'), false);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('identity lookup falls back to the public profile when account info has no picture', async () => {
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/passport/web/account/info/')) {
      return Response.json(
        { data: { user_id_str: '1234567890123456', username: 'sample.user', avatar_url: '' } },
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (new Headers(init?.headers).get('cookie') === null) {
      return new Response('{"statusCode":209002}');
    }
    return new Response(
      'x{"avatarLarger":"https:\\u002F\\u002Fp19-common-sign.tiktokcdn.com\\u002Fpic~c5.jpeg?x=1"}y',
    );
  }) as typeof fetch;
  try {
    const identity = await lookupTikTokIdentity('sessionid=abc');
    assert.equal(identity?.avatarUrl, 'https://p19-common-sign.tiktokcdn.com/pic~c5.jpeg?x=1');
    assert.ok(requested.some((url) => url === 'https://www.tiktok.com/@sample.user'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('identity lookup prefers the current profile picture over the older account-info one', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/passport/web/account/info/')) {
      return Response.json(
        {
          data: {
            user_id_str: '1234567890123456',
            username: 'sample.user',
            avatar_url: 'https://p16-amd-va.tiktokcdn.com/old-thumb.jpeg',
          },
        },
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      '{"avatarLarger":"https:\\u002F\\u002Fp19-common-sign.tiktokcdn.com\\u002Fnew.jpeg"}',
    );
  }) as typeof fetch;
  try {
    const identity = await lookupTikTokIdentity('sessionid=abc');
    assert.equal(identity?.avatarUrl, 'https://p19-common-sign.tiktokcdn.com/new.jpeg');
  } finally {
    globalThis.fetch = realFetch;
  }
  // When the profile page cannot be read, the account-info picture is still used.
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes('/passport/web/account/info/')) {
      return Response.json(
        {
          data: {
            user_id_str: '1234567890123456',
            username: 'sample.user',
            avatar_url: 'https://p16-amd-va.tiktokcdn.com/old-thumb.jpeg',
          },
        },
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('blocked', { status: 403 });
  }) as typeof fetch;
  try {
    const identity = await lookupTikTokIdentity('sessionid=abc');
    assert.equal(identity?.avatarUrl, 'https://p16-amd-va.tiktokcdn.com/old-thumb.jpeg');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an expired account session can be renewed in place, but only with the same TikTok account', async () => {
  let current: { userId: string; username: string } | null = {
    userId: '1234567890123456789',
    username: 'sample.user',
  };
  const fixture = accountFixture(async () => current);
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Keep my name', curl: syntheticCurl },
  });
  const accountId = imported.json().item.id as string;
  const url = `/api/v1/accounts/${accountId}/session`;
  const renew = (payload: object, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { ...headers, ...extra }, payload });
  current = null;
  const verified = await app.inject({
    method: 'POST',
    url: `/api/v1/accounts/${accountId}/verify`,
    headers,
  });
  assert.equal(verified.json().item.verificationStatus, 'disconnected');
  assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);
  assert.equal(
    (await renew({ sessionid: 'abcdef1234567890abcdef' }, { 'x-livehub-owner': 'owner-2' }))
      .statusCode,
    404,
  );
  assert.equal((await renew({})).statusCode, 400);
  assert.equal(
    (await renew({ curl: syntheticCurl, sessionid: 'abcdef1234567890abcdef' })).statusCode,
    400,
  );
  assert.equal((await renew({ sessionid: 'abcdef1234567890abcdef' })).statusCode, 422);
  current = { userId: '9999999999999999999', username: 'someone.else' };
  const wrong = await renew({ sessionid: 'abcdef1234567890abcdef' });
  assert.equal(wrong.statusCode, 409);
  assert.equal(fixture.rows[0].verificationStatus, 'disconnected');
  current = { userId: '1234567890123456789', username: 'sample.user' };
  const renewed = await renew({ sessionid: 'newsession1234567890abcdef' });
  assert.equal(renewed.statusCode, 200);
  assert.equal(renewed.json().item.verificationStatus, 'connected');
  assert.equal(renewed.json().item.alias, 'Keep my name');
  assert.equal(renewed.body.includes('newsession'), false);
  assert.equal(
    decryptAccountCookie(fixture.rows[0], fixture.key, 'owner-1', accountId),
    'sessionid=newsession1234567890abcdef',
  );
  await app.close();
});
