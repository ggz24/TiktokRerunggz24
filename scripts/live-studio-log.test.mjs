import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPushDestinations } from './live-studio-log.mjs';

test('extracts a TikTok CDN destination without the enclosing log quote', () => {
  const line =
    "[2026-09-28T15:58:06.373] [INFO] stream 'rtmp://push-rtmp-l1-sg01.tiktokcdn.com/game/stream-example?wsTime=123&wsSecret=fake'";
  const values = extractPushDestinations(line);
  assert.equal(values.length, 1);
  assert.equal(values[0].rtmpUrl, 'rtmp://push-rtmp-l1-sg01.tiktokcdn.com/game');
  assert.equal(values[0].streamKey, 'stream-example?wsTime=123&wsSecret=fake');
});

test('rejects a lookalike host and incomplete URL', () => {
  const text = [
    '[2026-09-28T15:58:06.373] fake rtmp://push-rtmp-l1-sg01.tiktokcdn.com.evil.test/game/stream-fake',
    '[2026-09-28T15:58:07.373] incomplete rtmp://push-rtmp-l1-sg01.tiktokcdn.com/game',
  ].join('\n');
  assert.deepEqual(extractPushDestinations(text), []);
});
