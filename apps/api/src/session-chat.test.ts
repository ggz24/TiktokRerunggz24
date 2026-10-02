import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { SessionChat } from './session-chat.js';
import type { CommentReplyService } from './ai-comments.js';
const room = '7692008313688574727';
const body = {
  content: 'ทดสอบ',
  meta: { source: 2, app_id: 253642, room_id: room, ec_streamer_key: 'fake-key' },
  client_start_time_stamp_millisecond: '1790935330394',
};
const capture = `curl --url 'https://shop.tiktok.com/api/v1/streamer_desktop/message/chat' -H 'content-type: application/json' -b 'sessionid=fake-cookie' --data-raw '${JSON.stringify(body)}'`;
function fixture(receiverRoom = room) {
  const rows = new Map<string, unknown>();
  const pool = {
    async query(sql: string, values: unknown[]) {
      const scope = `${values[0]}:${values[1]}`;
      if (sql.startsWith('INSERT')) rows.set(scope, JSON.parse(String(values[2])));
      if (sql.startsWith('DELETE')) rows.delete(scope);
      return { rows: rows.has(scope) ? [{ secret: rows.get(scope) }] : [] };
    },
  } as unknown as Pool;
  let closed = 0,
    sendCount = 0;
  const receiver = Object.assign(new EventEmitter(), {
    connect: async () => ({ roomId: receiverRoom }),
    disconnect: () => {
      closed++;
    },
  });
  const connector = new SessionChat(
    pool,
    Buffer.alloc(32, 1),
    async (o) => (o === 'owner' ? { handle: 'host', userId: '1234567890' } : null),
    () => receiver,
    async () => ({ username: 'host', userId: '1234567890' }),
    async (_capture, options) => {
      assert.equal(await options.currentRoom(), receiverRoom);
      assert.equal(options.roomId, receiverRoom);
      sendCount++;
      return {
        status: 'accepted',
        code: 0,
        moderationFlag: 1,
        deliveryConfirmed: false,
        httpStatus: 200,
      };
    },
  );
  return { connector, receiver, rows, closed: () => closed, sent: () => sendCount };
}
async function connect(f: ReturnType<typeof fixture>) {
  await f.connector.configure('owner', 'account', capture);
  await f.connector.ready('owner', 'account');
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}
test('encrypted session stays owner scoped; matching live room permits direct sending', async () => {
  const f = fixture();
  await connect(f);
  assert.equal(JSON.stringify([...f.rows.values()]).includes('fake-cookie'), false);
  assert.equal(await f.connector.savedCapture('owner', 'account'), capture);
  await assert.rejects(f.connector.savedCapture('other', 'account'), /ไม่พบบัญชี/);
  assert.equal(await f.connector.ready('owner', 'account'), true);
  assert.equal(await f.connector.ready('other', 'account'), false);
  await f.connector.send('owner', 'account', room, 'ตอบแล้ว');
  assert.equal(f.sent(), 1);
  assert.equal(
    JSON.stringify(await f.connector.connectionStatus('owner', 'account')).includes('fake-cookie'),
    false,
  );
  await f.connector.close();
});
test('new discovered LIVE replaces the old room; old room cannot send and removal closes receiver', async () => {
  const f = fixture('7692008313688574728');
  await connect(f);
  assert.equal(await f.connector.ready('owner', 'account'), true);
  await assert.rejects(f.connector.send('owner', 'account', room, 'ตอบ'), /ไม่พร้อม/);
  await f.connector.send('owner', 'account', '7692008313688574728', 'ตอบ');
  await f.connector.configure('owner', 'account', null);
  assert.equal(f.rows.size, 0);
  assert.ok(f.closed() > 0);
  await f.connector.close();
});
test('fresh chat goes to AI but host messages and stale events do not', async () => {
  const f = fixture();
  const events: { roomId: string }[] = [];
  f.connector.attach({
    process: async (_owner: string, _account: string, event: { roomId: string }) => {
      events.push(event);
    },
  } as unknown as CommentReplyService);
  await connect(f);
  f.receiver.emit('chat', {
    msgId: '7692008313688574729',
    comment: 'ราคาเท่าไร',
    user: { userId: '2222222222' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].roomId, room);
  f.receiver.emit('chat', {
    msgId: '7692008313688574730',
    comment: 'เจ้าของ',
    user: { userId: '1234567890' },
  });
  f.receiver.emit('chat', {
    msgId: '7692008313688574731',
    comment: 'เก่า',
    createTime: 1,
    user: { userId: '2222222222' },
  });
  assert.equal(events.length, 1);
  await f.connector.close();
});
test('v3 LIVE payload content and user.id reach AI; host and wrong-room messages are ignored', async () => {
  const f = fixture();
  const events: { comment: string }[] = [];
  f.connector.attach({
    process: async (_owner: string, _account: string, event: { comment: string }) =>
      events.push(event),
  } as unknown as CommentReplyService);
  await connect(f);
  const message = {
    common: {
      msgId: '7692008313688574729',
      roomId: room,
      createTime: String(Math.floor(Date.now() / 1000)),
    },
    content: 'ราคาเท่าไร',
    user: { id: '2222222222' },
  };
  f.receiver.emit('chat', message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0]?.comment, 'ราคาเท่าไร');
  f.receiver.emit('chat', { ...message, user: { id: '1234567890' } });
  f.receiver.emit('chat', {
    ...message,
    common: { ...message.common, roomId: '7692008313688574728' },
  });
  assert.equal(events.length, 1);
  await f.connector.close();
});
