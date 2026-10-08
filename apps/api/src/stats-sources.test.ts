import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import {
  StatsSourceService,
  createMemoryStatsSourceStore,
  openSecret,
  sealSecret,
  type StatsFetcher,
} from './stats-sources.js';
import { registerStatsSourceRoutes } from './stats-sources-routes.js';

const url = 'https://shop.tiktok.com/api/v1/creator/live/overview?range=7d&X-Bogus=fake-sign';
const curl = (cookie = "-b 'sessionid=copied-cookie'") =>
  `curl '${url}' -H 'accept: application/json' -H 'user-agent: test-browser' ${cookie}`;
const account = randomUUID();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function make(fetcher: StatsFetcher, cookie: string | null = 'sessionid=account-cookie') {
  const calls: { url: string; init: RequestInit }[] = [];
  const service = new StatsSourceService(createMemoryStatsSourceStore(), {
    cookieFor: async (owner, id) => (owner === 'owner' && id === account ? cookie : null),
    accountExists: async (owner, id) => owner === 'owner' && id === account,
    fetcher: async (u, init) => {
      calls.push({ url: u, init });
      return fetcher(u, init);
    },
  });
  return { service, calls };
}

test('the saved request is encrypted and bound to its owner and id', () => {
  const key = randomBytes(32);
  const id = randomUUID();
  const box = sealSecret(
    '{"url":"https://shop.tiktok.com/x","cookieHeader":"sessionid=secret"}',
    key,
    'owner',
    id,
  );
  assert.equal(box.ciphertext.includes(Buffer.from('sessionid')), false);
  assert.match(openSecret(box, key, 'owner', id), /sessionid=secret/);
  assert.throws(() => openSecret(box, key, 'other', id));
  assert.throws(() => openSecret(box, key, 'owner', randomUUID()));
  assert.throws(() => openSecret(box, randomBytes(32), 'owner', id));
});

test('creating a source stores no readable request and the list never shows it', async () => {
  const { service } = make(async () => json(200, {}));
  const item = await service.create('owner', {
    name: ' ยอดไลฟ์วันนี้ ',
    curl: curl(),
    accountId: account,
  });
  assert.equal(item.name, 'ยอดไลฟ์วันนี้');
  assert.deepEqual(
    [item.host, item.path, item.method, item.hasCookie],
    ['shop.tiktok.com', '/api/v1/creator/live/overview', 'GET', true],
  );
  const text = JSON.stringify(await service.list('owner'));
  assert.equal(/copied-cookie|X-Bogus|fake-sign|range=7d|test-browser/.test(text), false);
  assert.equal((await service.list('intruder')).length, 0);
  await assert.rejects(service.create('owner', { name: '', curl: curl() }), /ชื่อ/);
  await assert.rejects(
    service.create('owner', { name: 'x', curl: 'curl https://evil.example/' }),
    /ไม่ถูกต้อง/,
  );
  await assert.rejects(
    service.create('owner', { name: 'x', curl: curl(), accountId: randomUUID() }),
    /ไม่พบบัญชี/,
  );
});

test('the linked account session is used first, the copied cookie is the fallback', async () => {
  const { service, calls } = make(async () => json(200, { code: 0, data: { gmv: 100 } }));
  const linked = await service.create('owner', { name: 'a', curl: curl(), accountId: account });
  const result = await service.run('owner', linked.id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { code: 0, data: { gmv: 100 } });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(calls[0].url, url); // replayed unchanged, including its signature
  assert.equal(headers.cookie, 'sessionid=account-cookie');
  assert.equal(headers['user-agent'], 'test-browser');
  assert.equal(calls[0].init.redirect, 'manual');
  const unlinked = await service.create('owner', { name: 'b', curl: curl() });
  await service.run('owner', unlinked.id);
  assert.equal((calls[1].init.headers as Record<string, string>).cookie, 'sessionid=copied-cookie');
  const none = await service.create('owner', { name: 'c', curl: curl('') });
  const noSession = await service.run('owner', none.id);
  assert.equal(noSession.ok, false);
  assert.match(noSession.error ?? '', /ไม่มี session/);
  assert.equal(calls.length, 2); // nothing was sent without a session
});

test('another owner cannot run or change a source', async () => {
  const { service } = make(async () => json(200, {}));
  const item = await service.create('owner', { name: 'a', curl: curl() });
  await assert.rejects(service.run('intruder', item.id), /ไม่พบ/);
  await assert.rejects(service.update('intruder', item.id, { name: 'x' }), /ไม่พบ/);
  await assert.rejects(service.remove('intruder', item.id), /ไม่พบ/);
  assert.equal((await service.list('owner')).length, 1);
});

test('rejections and expired sessions explain themselves and never leak the request', async () => {
  const replies = [
    () => json(200, { code: 98001, message: 'sign invalid' }),
    () => json(403, { message: 'forbidden' }),
    () => new Response('<html>login</html>', { status: 200 }),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    () => {
      throw new Error('ECONNRESET sessionid=leak');
    },
  ];
  let n = 0;
  const { service } = make(async () => replies[n++]());
  const item = await service.create('owner', { name: 'a', curl: curl() });
  const results = [];
  for (let i = 0; i < replies.length; i += 1) results.push(await service.run('owner', item.id));
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, false, false, false, false],
  );
  assert.match(results[0].error!, /98001.*sign invalid/);
  assert.match(results[0].hint!, /คัดลอก cURL ใหม่/);
  assert.match(results[2].error!, /JSON/);
  assert.match(results[3].error!, /หน้าอื่น/);
  assert.equal(results[4].error, 'เชื่อมต่อ TikTok ไม่ได้');
  assert.equal(/leak|copied-cookie|fake-sign/.test(JSON.stringify(results)), false);
  assert.equal((await service.list('owner'))[0].lastStatus, 'network');
});

test('a fresh cURL replaces the old request and a huge answer is refused', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 10);
  let answer: Response = json(200, { code: 0, ok: 1 });
  const { service, calls } = make(async () => answer);
  const item = await service.create('owner', { name: 'a', curl: curl() });
  const updated = await service.update('owner', item.id, {
    curl: "curl 'https://seller-th.tiktok.com/api/x?new=1' -b 'sessionid=newer'",
  });
  assert.equal(updated.host, 'seller-th.tiktok.com');
  await service.run('owner', item.id);
  assert.equal(calls[0].url, 'https://seller-th.tiktok.com/api/x?new=1');
  answer = new Response(JSON.stringify({ blob: big }), { status: 200 });
  assert.match((await service.run('owner', item.id)).error ?? '', /ใหญ่เกินไป/);
  await assert.rejects(service.update('owner', item.id, {}), /ไม่มีสิ่งที่ต้องแก้/);
  await service.remove('owner', item.id);
  assert.equal((await service.list('owner')).length, 0);
});

test('running is rate limited per owner', async () => {
  const { service } = make(async () => json(200, { code: 0 }));
  const item = await service.create('owner', { name: 'a', curl: curl() });
  for (let i = 0; i < 30; i += 1) await service.run('owner', item.id);
  await assert.rejects(service.run('owner', item.id), /ถี่เกินไป/);
});

test('routes need the signed-in owner and do not return the request', async () => {
  const { service } = make(async () => json(200, { code: 0, data: { orders: 3 } }));
  const app = Fastify();
  registerStatsSourceRoutes(app, service, (h) =>
    h['x-internal-token'] === 't' ? String(h['x-livehub-owner'] ?? '') || null : null,
  );
  const owner = { 'x-internal-token': 't', 'x-livehub-owner': 'owner' };
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/stats-sources' })).statusCode, 401);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/stats-sources',
    headers: owner,
    payload: { name: 'ยอด', curl: curl() },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(/copied-cookie|fake-sign/.test(created.body), false);
  const id = JSON.parse(created.body).item.id as string;
  const run = await app.inject({
    method: 'POST',
    url: `/api/v1/stats-sources/${id}/run`,
    headers: owner,
    payload: {},
  });
  assert.equal(JSON.parse(run.body).data.data.orders, 3);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/stats-sources',
        headers: owner,
        payload: { name: 'x', curl: 'nope' },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/stats-sources/${id}`,
        headers: { ...owner, 'x-livehub-owner': 'other' },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/v1/stats-sources/${id}`, headers: owner }))
      .statusCode,
    200,
  );
  await app.close();
});
