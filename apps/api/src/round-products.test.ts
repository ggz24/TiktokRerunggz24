import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptAccountCookie, type AccountConfig } from './accounts.js';
import type { ProductSetStore } from './product-set-store.js';
import type { ProductPinStore } from './product-pin-store.js';
import type { LiveService } from './live-service.js';
import { createRoundProductActions, pinSelectedProduct } from './round-products.js';
import { createApp } from './app.js';
const owner = 'owner',
  account = '11111111-1111-4111-8111-111111111111',
  id = '22222222-2222-4222-8222-222222222222';
const product = '987654321',
  room = '123456789',
  oldRoom = '333333333',
  key = Buffer.alloc(32, 17);
function fixture() {
  const set = {
    id,
    accountId: account as string | null,
    autoApply: true,
    productIds: [product],
    curl: `curl 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/add?aid=253642&X-Bogus=old' -H 'content-type: application/json' -b 'sessionid=test-cookie' --data-raw '{"room_id":"${oldRoom}","product_info":[{"product_id":"${product}"}]}'`,
  };
  const sets = {
    list: async (who: string) => (who === owner ? [set] : []),
    find: async (who: string, setId: string) => (who === owner && setId === id ? set : null),
  } as unknown as ProductSetStore;
  let pinSaved = true,
    status = 'live',
    currentRoom = room;
  const pins = {
    has: async () => pinSaved,
    load: async () =>
      `curl 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/pin?X-Gnarly=old' -H 'content-type: application/json' -b 'sessionid=test-cookie' --data-raw '{"room_id":"${oldRoom}","product_id":"111111111","is_pinned":true}'`,
  } as unknown as ProductPinStore;
  const accounts = {
    encryptionKey: key,
    store: {
      findEncrypted: async (who: string, a: string) =>
        who === owner && a === account
          ? encryptAccountCookie('sessionid=test-cookie', key, owner, account)
          : null,
    },
  } as unknown as AccountConfig;
  const live = {
    stopAll: async () => {},
    session: async () => ({ status }),
    currentRoomId: async () => currentRoom,
  } as unknown as LiveService;
  const sent: { url: string; body: string; cookie: string }[] = [],
    delays: number[] = [];
  const actions = createRoundProductActions(
    sets,
    pins,
    accounts,
    live,
    async (request, cookie) => {
      sent.push({ url: request.url, body: request.body, cookie });
      return 'accepted';
    },
    async (ms) => {
      delays.push(ms);
    },
  );
  const plan = { index: 0, productSetId: id, addProducts: true, pinProduct: true };
  return {
    actions,
    sets,
    accounts,
    live,
    plan,
    set,
    sent,
    delays,
    removePin() {
      pinSaved = false;
    },
    stop() {
      status = 'idle';
    },
    changeRoom() {
      currentRoom = '444444444';
    },
  };
}
test('new rooms add selected set before stream and pin its first product after the delay', async () => {
  const h = fixture();
  await h.actions.validate(owner, account, { productSetRotation: [id, id], autoPinProduct: true });
  const added = await h.actions.beforeStream(owner, account, room, h.plan);
  assert.equal(added, 'accepted');
  assert.equal(h.sent.length, 1);
  assert.equal(JSON.parse(h.sent[0].body).room_id, room);
  assert.equal(h.sent[0].url.includes('X-Bogus'), false);
  assert.equal(await h.actions.afterStream(owner, account, room, h.plan, added), 'accepted');
  assert.deepEqual(h.delays, [5000]);
  assert.equal(JSON.parse(h.sent[1].body).product_id, product);
  assert.equal(JSON.parse(h.sent[1].body).room_id, room);
  assert.equal(h.sent[1].cookie, 'sessionid=test-cookie');
  assert.equal(JSON.parse(h.sent[1].body).op, 1);
  assert.equal(new URL(h.sent[1].url).pathname, '/api/v1/streamer_desktop/live_product/pin');
});
test('pin stops on add rejection, stream stop or changed room; disabled actions make no requests', async () => {
  const h = fixture();
  assert.equal(await h.actions.afterStream(owner, account, room, h.plan, 'rejected'), 'unverified');
  assert.equal(h.sent.length, 0);
  assert.equal(h.delays.length, 0);
  h.stop();
  assert.equal(await h.actions.afterStream(owner, account, room, h.plan, 'accepted'), 'unverified');
  assert.equal(h.sent.length, 0);
  const other = fixture();
  other.changeRoom();
  await other.actions.afterStream(owner, account, room, other.plan, 'accepted');
  assert.equal(other.sent.length, 0);
  assert.equal(
    await h.actions.beforeStream(owner, account, room, { ...h.plan, addProducts: false }),
    'none',
  );
  assert.equal(
    await h.actions.afterStream(owner, account, room, { ...h.plan, pinProduct: false }, 'none'),
    'none',
  );
});
test('round products reject foreign accounts, deleted sets and mismatched captured sessions; no pin capture needed', async () => {
  const h = fixture();
  await assert.rejects(h.actions.validate('other', account, { productSetRotation: [id] }));
  await assert.rejects(h.actions.validate(owner, 'other', { productSetRotation: [id] }));
  await assert.rejects(
    h.actions.beforeStream(owner, account, room, { ...h.plan, productSetId: account }),
  );
  h.removePin();
  await h.actions.validate(owner, account, { autoPinProduct: true });
  h.set.curl = h.set.curl.replace('test-cookie', 'other-cookie');
  await assert.rejects(h.actions.beforeStream(owner, account, room, h.plan), /session/);
  assert.equal(h.sent.length, 0);
});

test('selected pin product belongs to the owned set and is used instead of the first product', async () => {
  const h = fixture(),
    second = '876543210';
  h.set.productIds.push(second);
  await h.actions.validate(owner, account, {
    productSetRotation: [id],
    autoPinProduct: true,
    productPinSelections: { [id]: second },
  });
  await h.actions.afterStream(
    owner,
    account,
    room,
    { ...h.plan, pinProductId: second },
    'accepted',
  );
  assert.equal(JSON.parse(h.sent[0].body).product_id, second);
  await assert.rejects(
    h.actions.validate(owner, account, { productPinSelections: { [id]: '111111111' } }),
    /ไม่ได้อยู่/,
  );
  await assert.rejects(
    h.actions.afterStream(
      owner,
      account,
      room,
      { ...h.plan, pinProductId: '111111111' },
      'accepted',
    ),
    /ไม่ได้อยู่/,
  );
  assert.equal(h.sent.length, 1);
});

test('manual pin checks owner, account, membership and active room before any external request', async () => {
  const h = fixture();
  let calls = 0;
  const send = async (request: { body: string }, cookie: string) => {
    calls++;
    assert.equal(JSON.parse(request.body).room_id, room);
    assert.equal(JSON.parse(request.body).op, 1);
    assert.equal(cookie, 'sessionid=test-cookie');
    return 'accepted' as const;
  };
  const pin = (who = owner, prod = product, setId = id) =>
    pinSelectedProduct(h.sets, h.accounts, h.live, send, who, account, setId, prod);
  await assert.rejects(pin('other'), /ไม่พบบัญชี/);
  await assert.rejects(pin(owner, product, account), /ชุดสินค้า/);
  await assert.rejects(pin(owner, '111111111'), /ไม่ได้อยู่/);
  assert.equal(calls, 0);
  assert.equal(await pin(), 'accepted');
  h.stop();
  await assert.rejects(pin(), /เริ่ม LIVE/);
  assert.equal(calls, 1);
});

test('manual pin API authenticates, rejects room overrides and returns outcome without credentials', async () => {
  const h = fixture(),
    token = 'synthetic-internal-token-12345678901234567890';
  let calls = 0;
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    { ...h.accounts, internalToken: token },
    h.live,
    async () => {
      calls++;
      return 'accepted';
    },
    h.sets,
  );
  const url = `/api/v1/live/sessions/${account}/pin-product`,
    headers = { 'x-internal-token': token, 'x-livehub-owner': owner };
  try {
    assert.equal(
      (await app.inject({ method: 'POST', url, payload: { setId: id, productId: product } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { setId: id, productId: product, roomId: room },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'x-livehub-owner': 'other' },
          payload: { setId: id, productId: product },
        })
      ).statusCode,
      404,
    );
    assert.equal(calls, 0);
    const result = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { setId: id, productId: product },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { outcome: 'accepted' });
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('unbound saved sets can join rounds for the matching account without changing their binding', async () => {
  const h = fixture();
  h.set.accountId = null;
  await h.actions.validate(owner, account, {
    productSetRotation: [id, id],
    autoAddProducts: true,
    autoPinProduct: true,
  });
  assert.equal(await h.actions.beforeStream(owner, account, room, h.plan), 'accepted');
  assert.equal(h.set.accountId, null);
  assert.equal(h.sent.length, 1);
  h.set.curl = h.set.curl.replace('test-cookie', 'other-cookie');
  await assert.rejects(
    h.actions.validate(owner, account, { productSetRotation: [id], autoAddProducts: true }),
    /session/,
  );
  assert.equal(h.sent.length, 1);
  h.set.accountId = '33333333-3333-4333-8333-333333333333';
  await assert.rejects(h.actions.validate(owner, account, { productSetRotation: [id] }), /บัญชี/);
});
