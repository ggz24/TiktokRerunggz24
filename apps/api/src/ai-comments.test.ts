import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import {
  CommentReplyService,
  createOpenAiReplyGenerator,
  createPgCommentReplyStore,
  defaultReplySettings,
  parseReplySettings,
  type CommentReplyStore,
  type ReplyEntry,
} from './ai-comments.js';
import { registerAiCommentRoutes } from './ai-comment-routes.js';

function fixture() {
  const settings = new Map<string, typeof defaultReplySettings>();
  const keys = new Map<string, string | null>();
  const history = new Map<string, ReplyEntry[]>();
  const ids = new Set<string>();
  const scope = (owner: string, account: string) => `${owner}:${account}`;
  const store: CommentReplyStore = {
    async key(o, a) {
      return keys.get(scope(o, a)) ?? null;
    },
    async saveKey(o, a, k) {
      keys.set(scope(o, a), k);
    },
    async settings(o, a) {
      return settings.get(scope(o, a)) ?? { ...defaultReplySettings, knowledge: 'ราคา 150 บาท' };
    },
    async save(o, a, s) {
      settings.set(scope(o, a), s);
    },
    async recent(o, a) {
      return history.get(scope(o, a)) ?? [];
    },
    async begin(o, a, event, entry) {
      const id = `${scope(o, a)}:${event}`;
      if (ids.has(id)) return false;
      ids.add(id);
      history.set(scope(o, a), [entry, ...(history.get(scope(o, a)) ?? [])]);
      return true;
    },
    async finish(o, a, id, result) {
      Object.assign(
        history.get(scope(o, a))!.find((e) => e.id === id)!,
        result,
      );
    },
  };
  let clock = 0;
  let roomOpen = true;
  const sent: string[] = [];
  const connector = {
    async ready() {
      return true;
    },
    async isCurrentRoom() {
      return roomOpen;
    },
    async send(_o: string, _a: string, _r: string, text: string) {
      sent.push(text);
    },
  };
  return {
    store,
    connector,
    sent,
    advance: () => {
      clock += 61_000;
    },
    now: () => clock,
    closeRoom: () => {
      roomOpen = false;
    },
  };
}
const event = { comment: 'ราคาเท่าไร', eventId: 'event-1', roomId: '123456789012' };

test('session configuration validates the body and never echoes credentials', async () => {
  const f = fixture();
  const calls: unknown[][] = [];
  const connector = {
    ...f.connector,
    configure: async (...args: [string, string, string | null]) => {
      calls.push(args);
    },
  };
  const service = new CommentReplyService(f.store, undefined, connector);
  for (const value of [
    { capture: '' },
    { capture: 'x', remove: true },
    { remove: false },
    { capture: 'x', unexpected: 1 },
  ])
    await assert.rejects(service.configureChat('owner', 'account', value), /ไม่ถูกต้อง/);
  assert.deepEqual(
    await service.configureChat('owner', 'account', { capture: 'fake-private-capture' }),
    { ok: true },
  );
  assert.deepEqual(calls[0], ['owner', 'account', 'fake-private-capture']);
  await service.configureChat('owner', 'account', { remove: true });
  assert.deepEqual(calls[1], ['owner', 'account', null]);
});

test('AUTO can be armed while disconnected, but preview and disconnected events never send', async () => {
  const f = fixture();
  const service = new CommentReplyService(f.store, async () => '150 บาท', undefined, f.now);
  assert.equal((await service.process('owner', 'account', event, true)).item?.status, 'draft');
  assert.equal(f.sent.length, 0);
  await service.save('owner', 'account', {
    ...defaultReplySettings,
    enabled: true,
    knowledge: 'สินค้า',
  });
  assert.equal((await service.state('owner', 'account')).settings.enabled, true);
  await assert.rejects(service.process('owner', 'account', event, false), /ยังไม่พร้อม/);
});

test('deduplicates events, enforces cooldown and isolates owners', async () => {
  const f = fixture();
  const service = new CommentReplyService(f.store, async () => '150 บาท', f.connector, f.now);
  await service.save('one', 'a', {
    ...defaultReplySettings,
    enabled: true,
    knowledge: 'ราคา 150 บาท',
  });
  await service.save('two', 'a', {
    ...defaultReplySettings,
    enabled: true,
    knowledge: 'ราคา 150 บาท',
  });
  assert.equal((await service.process('one', 'a', event, false)).item?.status, 'sent');
  await assert.rejects(
    service.process('one', 'a', { ...event, eventId: 'event-2' }, false),
    /ช่วงพัก/,
  );
  f.advance();
  assert.equal((await service.process('one', 'a', event, false)).duplicate, true);
  assert.equal((await service.process('two', 'a', event, false)).item?.status, 'sent');
  assert.equal(f.sent.length, 2);
});

test('blocks banned input/output and overlong replies', async () => {
  for (const [comment, answer] of [
    ['รักษาโรคได้ไหม', '150 บาท'],
    ['ราคาเท่าไร', 'หายขาดแน่นอน'],
    ['ราคาเท่าไร', 'a'.repeat(101)],
  ]) {
    const f = fixture();
    const service = new CommentReplyService(f.store, async () => answer, f.connector, f.now);
    await service.save('o', 'a', { ...defaultReplySettings, enabled: true, knowledge: 'สินค้า' });
    assert.equal(
      (await service.process('o', 'a', { ...event, comment }, false)).item?.status,
      'skipped',
    );
    assert.equal(f.sent.length, 0);
  }
});

test('rechecks disable and room closure while generation runs', async () => {
  for (const close of [false, true]) {
    const f = fixture();
    let release!: (s: string) => void;
    const service = new CommentReplyService(
      f.store,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      f.connector,
      f.now,
    );
    await service.save('o', 'a', { ...defaultReplySettings, enabled: true, knowledge: 'สินค้า' });
    const task = service.process('o', 'a', event, false);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    if (close) f.closeRoom();
    else await service.save('o', 'a', { ...defaultReplySettings, knowledge: 'สินค้า' });
    release('150 บาท');
    assert.equal((await task).item?.status, 'skipped');
    assert.equal(f.sent.length, 0);
  }
});

test('key stays encrypted and authenticated to its owner', async () => {
  let secret: unknown;
  const pool = {
    async query(sql: string, args: unknown[]) {
      if (sql.startsWith('INSERT')) {
        secret = JSON.parse(args[3] as string);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [{ secret }], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = createPgCommentReplyStore(pool, Buffer.alloc(32, 7));
  await store.saveKey('one', 'a', 'test-secret-key');
  assert.equal(JSON.stringify(secret).includes('test-secret-key'), false);
  assert.equal(await store.key('one', 'a'), 'test-secret-key');
  await assert.rejects(store.key('two', 'a'));
});

test('blank key preserves saved credentials; state never exposes credentials', async () => {
  const f = fixture();
  const service = new CommentReplyService(f.store);
  await service.save('o', 'a', { ...defaultReplySettings, apiKey: 'test-secret-key' });
  await service.save('o', 'a', { ...defaultReplySettings, apiKey: '' });
  assert.equal(await f.store.key('o', 'a'), 'test-secret-key');
  const state = await service.state('o', 'a');
  assert.equal(state.hasApiKey, true);
  assert.equal(JSON.stringify(state).includes('test-secret-key'), false);
});

test('OpenAI request has store false and sanitizes provider errors', async () => {
  const generator = createOpenAiReplyGenerator('private-key', 'gpt-4.1-mini', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.store, false);
    assert.equal(JSON.stringify(body).includes('private-key'), false);
    return Response.json({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '150 บาท' }] }],
    });
  });
  assert.equal(await generator('ราคา', defaultReplySettings), '150 บาท');
  const fail = createOpenAiReplyGenerator('private-key', 'model', async () =>
    Response.json({ error: 'private-key' }, { status: 401 }),
  );
  await assert.rejects(
    fail('ราคา', defaultReplySettings),
    (e) => e instanceof Error && !e.message.includes('private-key'),
  );
  assert.throws(() => parseReplySettings({ ...defaultReplySettings, maxWords: 0 }));
});

test('reasoning models get a separate token budget and low effort', async () => {
  for (const model of ['gpt-5-mini', 'gpt-5.4-nano', 'o4-mini']) {
    const generator = createOpenAiReplyGenerator('fake-key', model, async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.model, model);
      assert.equal(body.max_output_tokens, 2048);
      assert.deepEqual(body.reasoning, { effort: 'low' });
      return Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '150 บาท' }] }],
      });
    });
    assert.equal(await generator('ราคา', defaultReplySettings), '150 บาท');
  }
});

test('routes require auth, account ownership and valid body; events cannot send without connector', async () => {
  const f = fixture();
  const app = Fastify();
  const id = '00000000-0000-0000-0000-000000000001';
  registerAiCommentRoutes(
    app,
    new CommentReplyService(f.store, async () => '150 บาท'),
    (h) => (h['x-owner'] as string) || null,
    async (o) => o === 'owner',
  );
  assert.equal((await app.inject(`/api/v1/ai-comments/${id}`)).statusCode, 401);
  assert.equal(
    (await app.inject({ url: `/api/v1/ai-comments/${id}`, headers: { 'x-owner': 'other' } }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/ai-comments/${id}/preview`,
        headers: { 'x-owner': 'owner' },
        payload: { comment: 7 },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/ai-comments/${id}/events`,
        headers: { 'x-owner': 'owner' },
        payload: event,
      })
    ).statusCode,
    409,
  );
  await app.close();
});
test('saved chat cURL is returned only to the account owner and is never cached', async () => {
  const f = fixture();
  const app = Fastify();
  const id = '00000000-0000-0000-0000-000000000001';
  const connector = {
    ready: async () => false,
    isCurrentRoom: async () => false,
    send: async () => {},
    savedCapture: async (owner: string, account: string) => {
      assert.equal(owner, 'owner');
      assert.equal(account, id);
      return 'curl fake-secret';
    },
  };
  registerAiCommentRoutes(
    app,
    new CommentReplyService(f.store, undefined, connector),
    (h) => (h['x-owner'] as string) || null,
    async (o) => o === 'owner',
  );
  const url = `/api/v1/ai-comments/${id}/chat-session`;
  assert.equal((await app.inject(url)).statusCode, 401);
  const other = await app.inject({ url, headers: { 'x-owner': 'other' } });
  assert.equal(other.statusCode, 404);
  assert.equal(other.body.includes('fake-secret'), false);
  const owned = await app.inject({ url, headers: { 'x-owner': 'owner' } });
  assert.equal(owned.statusCode, 200);
  assert.equal(owned.headers['cache-control'], 'no-store');
  assert.equal(owned.json().capture, 'curl fake-secret');
  const state = await app.inject({
    url: `/api/v1/ai-comments/${id}`,
    headers: { 'x-owner': 'owner' },
  });
  assert.equal(state.body.includes('fake-secret'), false);
  await app.close();
});
