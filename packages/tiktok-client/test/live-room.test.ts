import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createTikTokLiveRoom, parseCreatedRoom, type CreateRoomInput } from '../src';

const input: CreateRoomInput = {
  title: 'Test room',
  categoryId: '5',
  cookieHeader: 'sessionid=fake-session',
  studioVersion: '0.1.2',
  deviceId: '123456789012345678',
  installId: '123456789012345679',
};

const success = {
  status_code: 0,
  data: {
    living_room_attrs: { room_id_str: '1234567890123456789' },
    stream_id_str: '2234567890123456789',
    stream_url: {
      rtmp_push_url: 'rtmps://live-upload.tiktokcdn.com/live/stream-secret?token=secret',
    },
    share_url: 'https://www.tiktok.com/@example/live',
  },
};

test('builds a signed create request and parses the room without a real network call', async () => {
  let called = false;
  const room = await createTikTokLiveRoom(
    input,
    async ({ aid, device_id, params, query, stub }) => {
      assert.equal(aid, '8311');
      assert.equal(device_id, input.deviceId);
      assert.equal(params.install_id, input.installId);
      assert.equal(new URLSearchParams(query).get('device_id'), input.deviceId);
      assert.match(stub, /^[a-f0-9]{32}$/);
      return { 'x-khronos': '1234567890', 'x-ladon': 'fake-ladon', 'x-argus': 'fake-argus' };
    },
    async (url, init) => {
      called = true;
      const target = new URL(String(url));
      assert.equal(target.origin, 'https://webcast.tiktok.com');
      assert.equal(target.pathname, '/webcast/room/create/');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('cookie'), input.cookieHeader);
      assert.equal(
        new Headers(init?.headers).get('x-ss-stub'),
        createHash('md5').update(String(init?.body)).digest('hex'),
      );
      assert.equal(new URLSearchParams(String(init?.body)).get('title'), input.title);
      return Response.json(success);
    },
  );
  assert.ok(called);
  assert.deepEqual(room, {
    roomId: '1234567890123456789',
    streamId: '2234567890123456789',
    rtmpUrl: 'rtmps://live-upload.tiktokcdn.com/live',
    streamKey: 'stream-secret?token=secret',
    shareUrl: 'https://www.tiktok.com/@example/live',
  });
});

test('rejects failed responses and untrusted stream destinations without exposing the key', () => {
  for (const payload of [
    { ...success, status_code: 1001 },
    { ...success, status_code: undefined },
    {
      ...success,
      data: { ...success.data, stream_url: { rtmp_push_url: 'rtmp://127.0.0.1/live/secret' } },
    },
    {
      ...success,
      data: {
        ...success.data,
        stream_url: { rtmp_push_url: 'rtmp://fake-tiktokcdn.com/live/secret' },
      },
    },
  ]) {
    assert.throws(
      () => parseCreatedRoom(payload),
      (error: Error) => !error.message.includes('secret'),
    );
  }
});

test('rejects malformed signing headers before sending any request', async () => {
  let called = false;
  await assert.rejects(
    createTikTokLiveRoom(
      input,
      async () => ({ 'x-khronos': '1', 'x-ladon': 'bad\r\nheader', 'x-argus': 'argus' }),
      async () => {
        called = true;
        throw new Error('Unexpected network call');
      },
    ),
    /invalid headers/,
  );
  assert.equal(called, false);
});
