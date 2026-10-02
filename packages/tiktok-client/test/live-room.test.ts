import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  createTikTokLiveRoom,
  checkTikTokLiveRoom,
  endTikTokLiveRoom,
  parseCreatedRoom,
  type CreateRoomInput,
} from '../src';

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

test('room rejection exposes only a bounded numeric status code', () => {
  assert.throws(
    () => parseCreatedRoom({ status_code: 12345, message: 'private-cookie' }),
    /code: 12345/,
  );
  assert.throws(
    () => parseCreatedRoom({ status_code: 'private-cookie', message: 'private-key' }),
    (error) => error instanceof Error && error.message === 'TikTok did not create a LIVE room.',
  );
});

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
      assert.equal(
        new URLSearchParams(String(init?.body)).get('close_room_when_close_stream'),
        'true',
      );
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

test('ends a known LIVE room with signed finish requests', async () => {
  let calls = 0;
  const result = await endTikTokLiveRoom(
    {
      cookieHeader: input.cookieHeader,
      studioVersion: input.studioVersion,
      deviceId: input.deviceId,
      installId: input.installId,
      roomId: '1234567890123456789',
      streamId: '2234567890123456789',
    },
    async ({ stub }) => {
      assert.match(stub, /^[a-f0-9]{32}$/);
      return { 'x-khronos': '1234567890', 'x-ladon': 'fake-ladon', 'x-argus': 'fake-argus' };
    },
    async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).pathname, '/webcast/room/ping/anchor/');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('cookie'), input.cookieHeader);
      assert.equal(new URLSearchParams(String(init?.body)).get('status'), '4');
      assert.equal(new URLSearchParams(String(init?.body)).get('room_id'), '1234567890123456789');
      return Response.json({ status_code: 0 });
    },
  );
  assert.equal(result, 'ended');
  assert.equal(calls, 2);
});

test('room check distinguishes the original room, closed room and rejected status', async () => {
  const room = {
    cookieHeader: input.cookieHeader,
    studioVersion: input.studioVersion,
    deviceId: input.deviceId,
    installId: input.installId,
    roomId: '1234567890123456789',
    streamId: '2234567890123456789',
  };
  const sign = async () => ({
    'x-khronos': '1234567890',
    'x-ladon': 'fake-ladon',
    'x-argus': 'fake-argus',
  });
  const response =
    (payload: unknown): typeof fetch =>
    async (url) => {
      assert.equal(new URL(String(url)).pathname, '/webcast/room/continue/');
      return Response.json(payload);
    };
  assert.equal(
    await checkTikTokLiveRoom(
      room,
      sign,
      response({
        status_code: 0,
        data: { room: { id_str: room.roomId } },
      }),
    ),
    'open',
  );
  assert.equal(
    await checkTikTokLiveRoom(
      room,
      sign,
      response({
        status_code: 0,
        data: { room: { id_str: '9999999999999999999' } },
      }),
    ),
    'closed',
  );
  assert.equal(
    await checkTikTokLiveRoom(
      room,
      sign,
      response({
        status_code: 30003,
        data: {},
      }),
    ),
    'closed',
  );
  await assert.rejects(
    checkTikTokLiveRoom(
      room,
      sign,
      response({
        status_code: 403,
        data: {},
      }),
    ),
  );
});
