import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from 'node:v8';
import { deviceRecord, directoryFromRecords, logRecords, uncompress } from './device-directory.mjs';
const record = (serial, number) => {
  const b = serialize({ serial, onlySerial: serial, name: 'SM-G950F', sort: number });
  b[1] = 16;
  return b;
};
const row = (key, seq, value, type = 1) => ({
  key: Buffer.from(key),
  seq: BigInt(seq),
  value,
  type,
});
test('Xiaowei numbers stay attached to serial across reordering and renumbering', () => {
  const rows = [
    row('a', 1, record('phone-a', 57)),
    row('b', 2, record('phone-b', 42)),
    row('a', 3, record('phone-a', 59)),
  ];
  assert.equal(deviceRecord(rows[0].value).number, 57);
  const d = directoryFromRecords(rows.reverse());
  assert.equal(d.get('phone-a').number, 59);
  assert.equal(d.get('phone-b').number, 42);
});
test('deleted, conflicting and unsupported records do not supply guessed numbers', () => {
  const d = directoryFromRecords([
    row('a', 1, record('phone-a', 57)),
    row('a', 2, Buffer.alloc(0), 0),
    row('b', 3, record('phone-b', 42)),
    row('c', 4, record('phone-c', 42)),
  ]);
  assert.equal(d.size, 0);
  assert.equal(deviceRecord(serialize({ session: 'secret', sort: 57 })), null);
});
function maskedCrc(b) {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0x82f63b78 : 0);
  }
  c = ~c >>> 0;
  return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0;
}
function vint(n) {
  const a = [];
  do {
    a.push((n & 127) | (n >= 128 ? 128 : 0));
    n >>>= 7;
  } while (n);
  return Buffer.from(a);
}
test('WAL checksums and incomplete writes prevent stale or corrupt reads', () => {
  const v = record('phone-a', 57),
    header = Buffer.alloc(12);
  header.writeBigUInt64LE(7n);
  header.writeUInt32LE(1, 8);
  const data = Buffer.concat([header, Buffer.from([1, 1, 97]), vint(v.length), v]);
  const physical = Buffer.alloc(7);
  physical.writeUInt32LE(maskedCrc(Buffer.concat([Buffer.from([1]), data])));
  physical.writeUInt16LE(data.length, 4);
  physical[6] = 1;
  const b = Buffer.concat([physical, data]);
  assert.equal(logRecords(b)[0].seq, 7n);
  assert.equal(logRecords(b.subarray(0, -1)).length, 0);
  const corrupt = Buffer.from(b);
  corrupt[20] ^= 1;
  assert.equal(logRecords(corrupt).length, 0);
});
test('Snappy decodes overlapping copies and rejects invalid offsets', () => {
  assert.equal(uncompress(Buffer.from([6, 0, 97, 18, 1, 0])).toString(), 'aaaaaa');
  assert.throws(() => uncompress(Buffer.from([6, 18, 1, 0])));
});
