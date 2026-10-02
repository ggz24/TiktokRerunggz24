import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLiveChatCurl, summarizeLiveChatCapture } from '../src';

const body = {
  content: 'สวัสดีค่ะ',
  meta: {
    source: 1,
    app_id: 123,
    room_id: '123456789012',
    ec_streamer_key: 'fake-streamer-secret',
  },
  client_start_time_stamp_millisecond: '1750000000000',
};
const endpoint =
  'https://shop.tiktok.com/api/v1/streamer_desktop/message/chat?X-Bogus=fake-signature&X-Gnarly=fake-signature&msToken=fake-token';
function curl(data: unknown = body, url = endpoint) {
  return `curl --url '${url}' -H 'content-type: application/json' -H 'user-agent: test-browser' -b 'sessionid=fake-cookie' --data-raw '${JSON.stringify(data)}'`;
}
test('parses a chat capture without executing or changing its signed request', () => {
  const result = parseLiveChatCurl(curl());
  assert.equal(result.roomId, body.meta.room_id);
  assert.equal(result.body, JSON.stringify(body));
  assert.equal(result.content, body.content);
  assert.equal(result.url, endpoint);
  const summary = JSON.stringify(summarizeLiveChatCapture(result));
  for (const secret of [
    'fake-streamer-secret',
    'fake-signature',
    'fake-cookie',
    'fake-token',
    body.meta.room_id,
    body.content,
  ])
    assert.equal(summary.includes(secret), false);
  assert.equal(summarizeLiveChatCapture(result).responseVerified, false);
});
test('rejects other hosts, paths, rooms, missing credentials and shell additions', () => {
  for (const input of [
    curl(body, 'https://example.com/api/v1/streamer_desktop/message/chat'),
    curl(body, 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/add'),
    curl({ ...body, meta: { ...body.meta, room_id: '' } }),
    curl({ ...body, content: 'a'.repeat(101) }),
    curl().replace("-b 'sessionid=fake-cookie'", ''),
    curl() + '; echo private',
    curl({ ...body, unexpected: 'private' }),
  ]) {
    assert.throws(
      () => parseLiveChatCurl(input),
      (error) => error instanceof Error && error.message === 'Invalid TikTok Shop live chat cURL.',
    );
  }
});
