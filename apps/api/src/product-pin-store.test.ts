import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { ProductPinStore } from './product-pin-store.js';
import { createApp } from './app.js';
import { encryptAccountCookie, type AccountStore } from './accounts.js';
import type { LiveService } from './live-service.js';
const curl = `curl 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/pin' -H 'content-type: application/json' -b 'sessionid=synthetic-private-cookie' --data-raw '{"room_id":"123456789","product_id":"987654321","is_pinned":true}'`;
test('pin requests are encrypted, owner/account scoped and reject ciphertext tampering', async () => {
  const rows = new Map<string, unknown>();
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      const scope = `${params[0]}:${params[1]}`;
      if (sql.startsWith('INSERT')) rows.set(scope, JSON.parse(params[2] as string));
      if (sql.startsWith('DELETE')) rows.delete(scope);
      return {
        rows: sql.startsWith('SELECT') && rows.has(scope) ? [{ secret: rows.get(scope) }] : [],
      };
    },
  } as unknown as Pool;
  const store = new ProductPinStore(pool, Buffer.alloc(32, 17));
  await store.save('owner', 'account', curl);
  assert.equal(JSON.stringify([...rows.values()]).includes('synthetic-private-cookie'), false);
  assert.equal(await store.load('owner', 'account'), curl);
  assert.equal(await store.load('other', 'account'), null);
  assert.equal(await store.load('owner', 'other'), null);
  rows.set('other:account', rows.get('owner:account'));
  await assert.rejects(store.load('other', 'account'));
  await assert.rejects(store.save('owner', 'account', 'curl https://example.invalid'));
  assert.equal(await store.load('owner', 'account'), curl);
  await store.save('owner', 'account', null);
  assert.equal(await store.has('owner', 'account'), false);
});

test('pin routes require authentication, bind captured session to the selected account and expose metadata only', async () => {
  const account = '11111111-1111-4111-8111-111111111111',
    owner = 'owner',
    token = 'synthetic-private-internal-token-1234567890',
    key = Buffer.alloc(32, 17);
  let saved: string | null = null;
  const store = {
    findEncrypted: async (who: string, id: string) =>
      who === owner && id === account
        ? encryptAccountCookie('sessionid=synthetic-private-cookie', key, owner, account)
        : null,
  } as unknown as AccountStore;
  const live = { stopAll: async () => {} } as unknown as LiveService;
  const pins = {
    save: async (_o: string, _a: string, value: string | null) => {
      saved = value;
    },
    has: async () => !!saved,
  } as unknown as ProductPinStore;
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    { store, encryptionKey: key, internalToken: token },
    live,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pins,
  );
  const url = `/api/v1/live/sessions/${account}/product-pin`,
    headers = { 'x-internal-token': token, 'x-livehub-owner': owner };
  try {
    assert.equal((await app.inject({ method: 'PUT', url, payload: { curl } })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers: { ...headers, 'x-livehub-owner': 'other' },
          payload: { curl },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers,
          payload: { curl: curl.replace('synthetic-private-cookie', 'other-cookie') },
        })
      ).statusCode,
      409,
    );
    assert.equal(saved, null);
    const put = await app.inject({ method: 'PUT', url, headers, payload: { curl } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json(), { hasRequest: true });
    assert.equal(saved, curl);
    const get = await app.inject({ method: 'GET', url, headers });
    assert.deepEqual(get.json(), { hasRequest: true });
    assert.equal(get.body.includes('cookie'), false);
    assert.equal(
      (await app.inject({ method: 'PUT', url, headers, payload: { curl, extra: true } }))
        .statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'PUT', url, headers, payload: { curl: null } })).statusCode,
      200,
    );
    assert.equal(saved, null);
  } finally {
    await app.close();
  }
});
