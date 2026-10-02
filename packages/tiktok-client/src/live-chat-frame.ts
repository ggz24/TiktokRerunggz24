import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';

type Field = { tag: number; integer?: bigint; bytes?: Buffer };
const maxFrame = 1024 * 1024;
const maxPayload = 4 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function fields(buffer: Buffer): Field[] {
  let cursor = 0;
  function varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (cursor >= buffer.length) throw new Error('truncated');
      const byte = buffer[cursor++];
      if (shift === 63n && byte > 1) throw new Error('overflow');
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('varint');
  }
  const result: Field[] = [];
  while (cursor < buffer.length) {
    if (result.length >= 20000) throw new Error('fields');
    const key = varint();
    const tag = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (tag < 1 || tag > 536870911) throw new Error('tag');
    if (wire === 0) result.push({ tag, integer: varint() });
    else {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || !Number.isSafeInteger(length) || cursor + length > buffer.length)
        throw new Error('length');
      if (wire === 2) result.push({ tag, bytes: buffer.subarray(cursor, cursor + length) });
      cursor += length;
    }
  }
  return result;
}
function single(items: Field[], tag: number): Field | undefined {
  const found = items.filter((item) => item.tag === tag);
  if (found.length > 1) throw new Error('duplicate');
  return found[0];
}
function text(items: Field[], tag: number): string | undefined {
  const bytes = single(items, tag)?.bytes;
  return bytes ? utf8.decode(bytes) : undefined;
}
function id(items: Field[], tag: number): string | undefined {
  const value = single(items, tag)?.integer;
  return value && value > 0n ? value.toString() : undefined;
}

export type LiveChatEvent = {
  eventId: string;
  roomId: string;
  senderId: string;
  comment: string;
  createdAt?: number;
};

/** Decode the observed Shop webcast envelope. No network or chat-send side effects.
 * The caller must bind the authenticated connection to the account and active room.
 */
export function decodeLiveChatFrame(frame: Uint8Array, expectedRoomId: string): LiveChatEvent[] {
  try {
    if (!/^\d{8,24}$/.test(expectedRoomId) || !frame.length || frame.length > maxFrame)
      throw new Error('frame');
    const outer = fields(Buffer.from(frame));
    const payload = single(outer, 8)?.bytes;
    if (!payload) throw new Error('payload');
    const headers = outer.filter((field) => field.tag === 5 && field.bytes);
    let compression: string | undefined;
    for (const header of headers) {
      const pair = fields(header.bytes!);
      if (text(pair, 1) === 'compress_type') {
        if (compression !== undefined) throw new Error('compression');
        compression = text(pair, 2);
      }
    }
    if (compression === undefined) compression = text(outer, 6);
    if (!['gzip', 'none', undefined, ''].includes(compression)) throw new Error('compression');
    const decoded =
      compression === 'gzip' ? gunzipSync(payload, { maxOutputLength: maxPayload }) : payload;
    if (decoded.length > maxPayload) throw new Error('payload');
    const events: LiveChatEvent[] = [];
    const seen = new Set<string>();
    for (const envelope of fields(decoded).filter((field) => field.tag === 1 && field.bytes)) {
      const message = fields(envelope.bytes!);
      if (text(message, 1) !== 'WebcastChatMessage') continue;
      const body = single(message, 2)?.bytes;
      if (!body) throw new Error('chat');
      const chat = fields(body);
      const commonBytes = single(chat, 1)?.bytes;
      const senderBytes = single(chat, 2)?.bytes;
      if (!commonBytes || !senderBytes) throw new Error('context');
      const common = fields(commonBytes);
      const eventId = id(common, 2);
      const roomId = id(common, 3);
      const senderId = id(fields(senderBytes), 1);
      const comment = text(chat, 3);
      if (
        text(common, 1) !== 'WebcastChatMessage' ||
        !eventId ||
        !roomId ||
        !senderId ||
        !comment?.trim() ||
        Array.from(comment).length > 2000 ||
        // Reject control characters in decoded chat text.
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(comment)
      )
        throw new Error('chat');
      if (roomId !== expectedRoomId || seen.has(eventId)) continue;
      seen.add(eventId);
      const timestamp = single(common, 4)?.integer;
      const createdAt =
        timestamp && timestamp < 100000000000000n
          ? Number(timestamp) * (timestamp < 100000000000n ? 1000 : 1)
          : undefined;
      events.push({ eventId, roomId, senderId, comment, ...(createdAt ? { createdAt } : {}) });
      if (events.length > 500) throw new Error('events');
    }
    return events;
  } catch {
    throw new Error('Invalid TikTok live chat frame.');
  }
}
