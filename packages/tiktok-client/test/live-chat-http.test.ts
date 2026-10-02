import assert from 'node:assert/strict';
import test from 'node:test';
import { sendCapturedLiveChat, sendLiveChatWithSession } from '../src';
const now = 1790928000000;
const room = '7691973712425913109';
const body = JSON.stringify({
  content: 'ทดสอบ',
  meta: { source: 1, app_id: 123, room_id: room, ec_streamer_key: 'fake-secret' },
  client_start_time_stamp_millisecond: String(now),
});
const url = 'https://shop.tiktok.com/api/v1/streamer_desktop/message/chat?X-Bogus=fake';
const capture = `curl --url '${url}' -H 'content-type: application/json' -b 'sessionid=fake' --data-raw '${body}'`;
test('direct sender preserves captured signed bytes and accepts observed punish=1', async () => {
  let count = 0;
  const result = await sendCapturedLiveChat(capture, {
    now,
    currentRoom: async () => room,
    fetch: async (u, init) => {
      count++;
      assert.equal(u, url);
      assert.equal(init?.body, body);
      assert.equal(init?.redirect, 'error');
      return Response.json({ code: 0, data: { punish: 1 } });
    },
  });
  assert.equal(count, 1);
  assert.equal(result.status, 'accepted');
  assert.equal(result.deliveryConfirmed, false);
});
test('old capture and closed or changed room cannot send', async () => {
  const noFetch: typeof fetch = async () => {
    throw new Error('must not send');
  };
  await assert.rejects(
    sendCapturedLiveChat(capture, {
      now: now + 300001,
      currentRoom: async () => room,
      fetch: noFetch,
    }),
    /expired/,
  );
  for (const r of [null, '7691973712425913110'])
    await assert.rejects(
      sendCapturedLiveChat(capture, { now, currentRoom: async () => r, fetch: noFetch }),
      /current LIVE room/,
    );
});
test('ambiguous send is sanitized and never retried', async () => {
  let count = 0;
  await assert.rejects(
    sendCapturedLiveChat(capture, {
      now,
      currentRoom: async () => room,
      fetch: async () => {
        count++;
        throw new Error('fake-secret signed-url');
      },
    }),
    /^Error: Chat send result is unknown\. Do not automatically retry\.$/,
  );
  assert.equal(count, 1);
});
test('session sender uses new text/time and excludes captured signatures', async () => {
  const result = await sendLiveChatWithSession(capture, {
    content: 'คำตอบใหม่',
    now: now + 3600000,
    currentRoom: async () => room,
    fetch: async (u, init) => {
      const endpoint = new URL(String(u));
      assert.equal(endpoint.origin, 'https://shop.tiktok.com');
      for (const name of ['X-Bogus', 'X-Gnarly', 'msToken', 'X-Tts-Oec-Bsid'])
        assert.equal(endpoint.searchParams.has(name), false);
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.content, 'คำตอบใหม่');
      assert.equal(sent.meta.room_id, room);
      assert.equal(sent.client_start_time_stamp_millisecond, String(now + 3600000));
      assert.equal((init?.headers as Record<string, string>).cookie, 'sessionid=fake');
      return Response.json({ code: 0, data: { punish: 1 } });
    },
  });
  assert.equal(result.status, 'accepted');
});
test('session sender requires a matching current room and bounded content', async () => {
  const noFetch: typeof fetch = async () => {
    throw new Error('must not send');
  };
  await assert.rejects(
    sendLiveChatWithSession(capture, {
      content: 'ตอบ',
      currentRoom: async () => null,
      fetch: noFetch,
    }),
    /current LIVE room/,
  );
  await assert.rejects(
    sendLiveChatWithSession(capture, {
      content: 'ก'.repeat(101),
      currentRoom: async () => room,
      fetch: noFetch,
    }),
    /100 characters/,
  );
});
test('session sender can bind a new receiver-verified room without replaying captured room metadata', async () => {
  const nextRoom = '7692008313688574728';
  await sendLiveChatWithSession(capture, {
    content: 'ห้องใหม่',
    roomId: nextRoom,
    currentRoom: async () => nextRoom,
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).meta.room_id, nextRoom);
      return Response.json({ code: 0, data: { punish: 1 } });
    },
  });
});
