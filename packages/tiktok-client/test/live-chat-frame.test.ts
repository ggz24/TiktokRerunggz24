import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { decodeLiveChatFrame, inspectLiveChatResponse } from '../src';

function varint(value: bigint): Buffer {
  const bytes: number[] = [];
  do {
    bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0));
    value >>= 7n;
  } while (value);
  return Buffer.from(bytes);
}
function integer(tag: number, value: bigint): Buffer {
  return Buffer.concat([varint(BigInt(tag * 8)), varint(value)]);
}
function bytes(tag: number, value: string | Buffer): Buffer {
  const data = Buffer.from(value);
  return Buffer.concat([varint(BigInt(tag * 8 + 2)), varint(BigInt(data.length)), data]);
}
const room = '7690000000000000001';
const event = '7690000000000000002';
function message(method = 'WebcastChatMessage', comment = 'Test'): Buffer {
  const common = Buffer.concat([
    bytes(1, method),
    integer(2, BigInt(event)),
    integer(3, BigInt(room)),
  ]);
  const body = Buffer.concat([
    bytes(1, common),
    bytes(2, integer(1, 1234567890123456789n)),
    bytes(3, comment),
  ]);
  return bytes(1, Buffer.concat([bytes(1, method), bytes(2, body)]));
}
function frame(payload: Buffer, compression = 'none'): Buffer {
  return Buffer.concat([
    bytes(5, Buffer.concat([bytes(1, 'compress_type'), bytes(2, compression)])),
    bytes(8, compression === 'gzip' ? gzipSync(payload) : payload),
  ]);
}
test('decodes observed chat field layout with gzip/none and preserves 64-bit IDs', () => {
  for (const compression of ['none', 'gzip']) {
    const events = decodeLiveChatFrame(frame(message(), compression), room);
    assert.deepEqual(events, [
      { eventId: event, roomId: room, senderId: '1234567890123456789', comment: 'Test' },
    ]);
    assert.deepEqual(decodeLiveChatFrame(frame(message(), compression), '7690000000000000009'), []);
  }
});
test('ignores other events and deduplicates repeated chat messages in one frame', () => {
  const payload = Buffer.concat([
    message('WebcastMemberMessage'),
    message(),
    message(),
    message('WebcastRoomUserSeqMessage'),
  ]);
  assert.equal(decodeLiveChatFrame(frame(payload), room).length, 1);
});
test('rejects corrupt protobuf, unsupported compression, oversized frames and unsafe text', () => {
  for (const input of [
    Buffer.from([0x42, 0xff]),
    frame(message(), 'brotli'),
    frame(message('WebcastChatMessage', '\u0000')),
    Buffer.alloc(1024 * 1024 + 1),
    frame(Buffer.from([0])),
    frame(
      bytes(1, Buffer.concat([bytes(1, 'WebcastChatMessage'), bytes(1, 'WebcastChatMessage')])),
    ),
    frame(Buffer.alloc(4 * 1024 * 1024 + 1), 'gzip'),
  ]) {
    assert.throws(() => decodeLiveChatFrame(input, room), {
      message: 'Invalid TikTok live chat frame.',
    });
  }
});
test('does not treat the observed punish=1 response as confirmed delivery', () => {
  assert.deepEqual(inspectLiveChatResponse({ code: 0, data: { punish: 1 } }), {
    status: 'accepted',
    code: 0,
    moderationFlag: 1,
    deliveryConfirmed: false,
  });
  assert.equal(inspectLiveChatResponse({ code: 0, data: { punish: 0 } }).status, 'accepted');
  assert.equal(inspectLiveChatResponse({ code: 12 }).status, 'rejected');
  assert.equal(inspectLiveChatResponse({ code: '0' }).status, 'unknown');
  assert.equal(inspectLiveChatResponse({ code: 0 }).status, 'review_required');
});
