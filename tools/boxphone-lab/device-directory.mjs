// Read only Xiaowei's device records. No WebView cookies, account records or writes.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

function varint(b, cursor) {
  let n = 0,
    scale = 1;
  for (let i = 0; i < 8; i++) {
    if (cursor.p >= b.length) throw Error('truncated');
    const x = b[cursor.p++];
    n += (x & 127) * scale;
    if (!(x & 128)) return n;
    scale *= 128;
  }
  throw Error('varint');
}
function crc32c(b) {
  let crc = 0xffffffff;
  for (const x of b) {
    crc ^= x;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return ~crc >>> 0;
}
function checksum(b, expected) {
  const c = crc32c(b);
  return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0 === expected;
}
export function uncompress(b) {
  const c = { p: 0 },
    size = varint(b, c);
  if (size > 16 * 1024 * 1024) throw Error('large block');
  const out = Buffer.alloc(size);
  let p = 0;
  while (c.p < b.length) {
    const tag = b[c.p++],
      type = tag & 3;
    let len, offset;
    if (type === 0) {
      len = tag >>> 2;
      if (len < 60) len++;
      else {
        const bytes = len - 59;
        if (c.p + bytes > b.length) throw Error('literal');
        len = b.readUIntLE(c.p, bytes) + 1;
        c.p += bytes;
      }
      if (p + len > size || c.p + len > b.length) throw Error('literal');
      b.copy(out, p, c.p, c.p + len);
      p += len;
      c.p += len;
      continue;
    }
    if (type === 1) {
      len = 4 + ((tag >>> 2) & 7);
      if (c.p >= b.length) throw Error('copy');
      offset = ((tag & 224) << 3) | b[c.p++];
    } else {
      len = 1 + (tag >>> 2);
      const bytes = type === 2 ? 2 : 4;
      if (c.p + bytes > b.length) throw Error('copy');
      offset = b.readUIntLE(c.p, bytes);
      c.p += bytes;
    }
    if (!offset || offset > p || p + len > size) throw Error('offset');
    for (let i = 0; i < len; i++) out[p + i] = out[p + i - offset];
    p += len;
  }
  if (p !== size) throw Error('length');
  return out;
}
function entries(block) {
  if (block.length < 4) throw Error('block');
  const count = block.readUInt32LE(block.length - 4),
    end = block.length - 4 - count * 4;
  if (count < 1 || end < 0) throw Error('restarts');
  const c = { p: 0 },
    result = [];
  let last = Buffer.alloc(0);
  while (c.p < end) {
    const shared = varint(block, c),
      added = varint(block, c),
      len = varint(block, c);
    if (shared > last.length || c.p + added + len > end) throw Error('entry');
    const key = Buffer.concat([last.subarray(0, shared), block.subarray(c.p, c.p + added)]);
    c.p += added;
    result.push({ key, value: block.subarray(c.p, c.p + len) });
    c.p += len;
    last = key;
  }
  return result;
}
function tableBlock(b, handle) {
  const c = { p: 0 },
    offset = varint(handle, c),
    size = varint(handle, c);
  if (offset + size + 5 > b.length) throw Error('handle');
  const type = b[offset + size],
    raw = b.subarray(offset, offset + size);
  if (!checksum(b.subarray(offset, offset + size + 1), b.readUInt32LE(offset + size + 1)))
    throw Error('checksum');
  if (type === 0) return raw;
  if (type === 1) return uncompress(raw);
  throw Error('compression');
}
export function tableRecords(b) {
  if (b.length < 48 || b.subarray(-8).toString('hex') !== '57fb808b247547db') return [];
  const footer = b.subarray(-48),
    c = { p: 0 };
  varint(footer, c);
  varint(footer, c);
  const index = tableBlock(b, footer.subarray(c.p));
  const result = [];
  for (const entry of entries(index))
    for (const row of entries(tableBlock(b, entry.value))) {
      if (row.key.length < 8) continue;
      const suffix = row.key.readBigUInt64LE(row.key.length - 8);
      result.push({
        key: row.key.subarray(0, -8),
        value: row.value,
        seq: suffix >> 8n,
        type: Number(suffix & 255n),
      });
    }
  return result;
}
function writeBatch(b) {
  if (b.length < 12) return [];
  const seq = b.readBigUInt64LE(0),
    count = b.readUInt32LE(8),
    c = { p: 12 },
    rows = [];
  if (count > 100000) throw Error('batch');
  for (let i = 0; i < count; i++) {
    const type = b[c.p++];
    if (type !== 0 && type !== 1) throw Error('batch type');
    const k = varint(b, c);
    if (c.p + k > b.length) throw Error('key');
    const key = b.subarray(c.p, c.p + k);
    c.p += k;
    let value = Buffer.alloc(0);
    if (type === 1) {
      const n = varint(b, c);
      if (c.p + n > b.length) throw Error('value');
      value = b.subarray(c.p, c.p + n);
      c.p += n;
    }
    rows.push({ key, value, seq: seq + BigInt(i), type });
  }
  if (c.p !== b.length) throw Error('batch length');
  return rows;
}
export function logRecords(b) {
  const rows = [];
  let fragments = [];
  for (let block = 0; block < b.length; block += 32768) {
    let p = block;
    const end = Math.min(block + 32768, b.length);
    while (p + 7 <= end) {
      const crc = b.readUInt32LE(p),
        len = b.readUInt16LE(p + 4),
        type = b[p + 6];
      p += 7;
      if (!len && !type) break;
      if (p + len > end) break;
      const data = b.subarray(p, p + len);
      p += len;
      if (!checksum(Buffer.concat([Buffer.from([type]), data]), crc)) {
        fragments = [];
        continue;
      }
      try {
        if (type === 1) {
          fragments = [];
          rows.push(...writeBatch(data));
        } else if (type === 2) fragments = [data];
        else if (type === 3 && fragments.length) fragments.push(data);
        else if (type === 4 && fragments.length) {
          fragments.push(data);
          rows.push(...writeBatch(Buffer.concat(fragments)));
          fragments = [];
        } else fragments = [];
      } catch {
        fragments = [];
      }
    }
  }
  return rows;
}
// Chromium uses a newer V8 wire version than Node. Decode only the four known
// primitive device fields, never deserialize or return arbitrary IndexedDB data.
export function deviceRecord(value) {
  const start = value.indexOf(Buffer.from([255, 16, 111]));
  if (start < 0) return null;
  const b = value.subarray(start + 3),
    c = { p: 0 };
  const readString = () => {
    const type = b[c.p++];
    if (type !== 34 && type !== 99) throw Error('string');
    const n = varint(b, c);
    if (n > 1024 || c.p + n > b.length) throw Error('string length');
    const s = b.subarray(c.p, c.p + n).toString(type === 99 ? 'utf16le' : 'latin1');
    c.p += n;
    return s;
  };
  try {
    if (readString() !== 'serial') return null;
    const serial = readString();
    if (
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(serial) ||
      readString() !== 'onlySerial' ||
      readString() !== serial ||
      readString() !== 'name'
    )
      return null;
    const name = readString();
    if (readString() !== 'sort' || b[c.p++] !== 73) return null;
    const z = varint(b, c),
      number = z % 2 ? -(z + 1) / 2 : z / 2;
    if (number < 1 || number > 99999) return null;
    return { serial, number, name };
  } catch {
    return null;
  }
}
export function directoryFromRecords(records) {
  const latest = new Map();
  for (const r of records) {
    const k = r.key.toString('hex');
    if (!latest.has(k) || latest.get(k).seq < r.seq) latest.set(k, r);
  }
  const bySerial = new Map();
  for (const r of latest.values()) {
    if (r.type !== 1) continue;
    const d = deviceRecord(r.value);
    if (d && (!bySerial.has(d.serial) || bySerial.get(d.serial).seq < r.seq))
      bySerial.set(d.serial, { ...d, seq: r.seq });
  }
  // Conflicting numbers are never guessed.
  const counts = new Map();
  for (const d of bySerial.values()) counts.set(d.number, (counts.get(d.number) || 0) + 1);
  return new Map(
    [...bySerial]
      .filter(([, d]) => counts.get(d.number) === 1)
      .map(([s, d]) => [s, { number: d.number, name: d.name }]),
  );
}
let cached = new Map(),
  cachedAt = 0;
export async function xiaoweiDirectory() {
  if (Date.now() - cachedAt < 10000) return cached;
  cachedAt = Date.now();
  const base = process.env.LOCALAPPDATA;
  if (!base) return (cached = new Map());
  const dir = path.join(
    base,
    'com.xiaowei.android',
    'EBWebView',
    'Default',
    'IndexedDB',
    'https_tauri.localhost_0.indexeddb.leveldb',
  );
  try {
    const records = [];
    const files = (await readdir(dir)).filter((f) => /^\d+\.(log|ldb|sst)$/.test(f));
    for (const file of files) {
      try {
        const p = path.join(dir, file);
        if ((await stat(p)).size > 32 * 1024 * 1024) continue;
        const b = await readFile(p);
        records.push(...(file.endsWith('.log') ? logRecords(b) : tableRecords(b)));
      } catch {}
    }
    cached = directoryFromRecords(records);
  } catch {
    cached = new Map();
  }
  return cached;
}
