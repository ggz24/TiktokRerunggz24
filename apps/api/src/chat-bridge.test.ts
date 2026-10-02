import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ChatBridge } from './chat-bridge.js';
import {
  CommentReplyService,
  defaultReplySettings,
  type CommentReplyStore,
} from './ai-comments.js';
import { registerChatBridgeRoutes } from './chat-bridge-routes.js';

function fixture() {
  let now = 1790925000000;
  let room = '7691973455174208257';
  let enabled = true;
  const generated: string[] = [];
  const bridge = new ChatBridge(
    async (owner, account) =>
      owner === 'owner' && account === 'account'
        ? { roomId: room, handle: 'testshop', userId: '7114255276555830298' }
        : null,
    () => now,
  );
  const store: CommentReplyStore = {
    async key() {
      return null;
    },
    async saveKey() {},
    async settings() {
      return { ...defaultReplySettings, enabled, knowledge: 'ราคา 150 บาท' };
    },
    async save() {},
    async recent() {
      return [];
    },
    async begin() {
      return true;
    },
    async finish() {},
  };
  bridge.attach(
    new CommentReplyService(
      store,
      async (text) => {
        generated.push(text);
        return '150 บาท';
      },
      bridge,
      () => now,
    ),
  );
  const context = {
    clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    roomId: room,
    handle: 'testshop',
    senderReady: true,
  };
  return {
    bridge,
    generated,
    context,
    advance: (ms = 3000) => {
      now += ms;
    },
    changeRoom: () => {
      room = '7691973455174208258';
    },
    disable: () => {
      enabled = false;
    },
  };
}
test('pairing is scoped, expires, and requires a current room heartbeat', async () => {
  const f = fixture();
  const pair = await f.bridge.pair('owner', 'account');
  assert.equal(await f.bridge.ready('owner', 'account'), false);
  await assert.rejects(f.bridge.pair('another', 'account'));
  await assert.rejects(f.bridge.relay('0'.repeat(64), { action: 'poll', ...f.context }));
  await f.bridge.relay(pair.token, { action: 'poll', ...f.context });
  assert.equal(await f.bridge.ready('owner', 'account'), true);
  assert.equal(await f.bridge.ready('another', 'account'), false);
  await assert.rejects(
    f.bridge.relay(pair.token, {
      action: 'poll',
      ...f.context,
      clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
  );
  f.advance(16000);
  assert.equal(await f.bridge.ready('owner', 'account'), false);
  f.advance(12 * 3600000);
  await assert.rejects(f.bridge.relay(pair.token, { action: 'poll', ...f.context }));
  f.bridge.close();
});
test('queued reply is issued once and acknowledged without retry', async () => {
  const f = fixture();
  const pair = await f.bridge.pair('owner', 'account');
  await f.bridge.relay(pair.token, { action: 'poll', ...f.context });
  const result = f.bridge.send('owner', 'account', pair.roomId, '150 บาท');
  await new Promise((resolve) => setImmediate(resolve));
  f.advance();
  const issued = await f.bridge.relay(pair.token, { action: 'poll', ...f.context });
  assert.ok('job' in issued && issued.job);
  if (!('job' in issued) || !issued.job) throw new Error('missing job');
  f.advance();
  assert.deepEqual(await f.bridge.relay(pair.token, { action: 'poll', ...f.context }), {
    job: null,
  });
  await f.bridge.relay(pair.token, {
    action: 'ack',
    ...f.context,
    jobId: issued.job.id,
    accepted: true,
  });
  await result;
  await f.bridge.relay(pair.token, {
    action: 'ack',
    ...f.context,
    jobId: issued.job.id,
    accepted: true,
  });
  f.changeRoom();
  assert.equal(await f.bridge.ready('owner', 'account'), false);
  await assert.rejects(f.bridge.send('owner', 'account', pair.roomId, 'ทดสอบ'));
  f.bridge.close();
});
test('disabling AUTO cancels queued replies and revoking invalidates tokens', async () => {
  const f = fixture();
  const pair = await f.bridge.pair('owner', 'account');
  await f.bridge.relay(pair.token, { action: 'poll', ...f.context });
  const result = f.bridge.send('owner', 'account', pair.roomId, '150 บาท');
  const rejected = assert.rejects(result);
  await new Promise((resolve) => setImmediate(resolve));
  f.disable();
  f.advance();
  assert.deepEqual(await f.bridge.relay(pair.token, { action: 'poll', ...f.context }), {
    job: null,
  });
  await rejected;
  f.bridge.revoke('owner', 'account');
  await assert.rejects(f.bridge.relay(pair.token, { action: 'poll', ...f.context }));
});
test('HTTP relay rejects missing authentication and unauthorized account management', async () => {
  const f = fixture();
  const app = Fastify();
  registerChatBridgeRoutes(
    app,
    f.bridge,
    () => null,
    async () => false,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/v1/chat-bridge/relay', payload: {} }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ai-comments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bridge/pair',
        payload: {},
      })
    ).statusCode,
    401,
  );
  await app.close();
  f.bridge.close();
});
function chatFrame(room: string, sender: string, timestamp: number, eventId: bigint) {
  function v(value: bigint): Buffer {
    const out: number[] = [];
    do {
      out.push(Number(value & 127n) | (value > 127n ? 128 : 0));
      value >>= 7n;
    } while (value);
    return Buffer.from(out);
  }
  const integer = (tag: number, value: bigint) => Buffer.concat([v(BigInt(tag * 8)), v(value)]);
  const bytes = (tag: number, value: string | Buffer) => {
    const data = Buffer.from(value);
    return Buffer.concat([v(BigInt(tag * 8 + 2)), v(BigInt(data.length)), data]);
  };
  const common = Buffer.concat([
    bytes(1, 'WebcastChatMessage'),
    integer(2, eventId),
    integer(3, BigInt(room)),
    integer(4, BigInt(timestamp)),
  ]);
  const body = Buffer.concat([
    bytes(1, common),
    bytes(2, integer(1, BigInt(sender))),
    bytes(3, 'ราคาเท่าไร'),
  ]);
  return bytes(
    8,
    bytes(1, Buffer.concat([bytes(1, 'WebcastChatMessage'), bytes(2, body)])),
  ).toString('base64');
}
test('fresh viewer frame flows through AI and queue; own and historical messages are ignored', async () => {
  const f = fixture();
  const pair = await f.bridge.pair('owner', 'account');
  await f.bridge.relay(pair.token, { action: 'poll', ...f.context });
  for (const [sender, timestamp, id] of [
    ['7114255276555830298', 1790925000000, 1n],
    ['1234567890123456789', 1790924900000, 2n],
  ] as const) {
    await f.bridge.relay(pair.token, {
      action: 'frame',
      ...f.context,
      frame: chatFrame(pair.roomId, sender, timestamp, id),
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.generated.length, 0);
  await f.bridge.relay(pair.token, {
    action: 'frame',
    ...f.context,
    frame: chatFrame(pair.roomId, '1234567890123456789', 1790925000000, 3n),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.generated, ['ราคาเท่าไร']);
  f.advance();
  const issued = await f.bridge.relay(pair.token, { action: 'poll', ...f.context });
  assert.ok('job' in issued && issued.job);
  if (!('job' in issued) || !issued.job) throw new Error('missing job');
  assert.equal(issued.job.text, '150 บาท');
  await f.bridge.relay(pair.token, {
    action: 'ack',
    ...f.context,
    jobId: issued.job.id,
    accepted: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  f.bridge.close();
});
