import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectChatNode,
  focusedComposer,
  verifiedSendTarget,
  stableTarget,
  prepareComposer,
} from './composer.mjs';
const pkg = 'com.zhiliaoapp.musically',
  size = { width: 1440, height: 2960 };
const bounds = (x1, y1, x2, y2) => ({
  x1,
  y1,
  x2,
  y2,
  cx: (x1 + x2) / 2,
  cy: (y1 + y2) / 2,
  w: x2 - x1,
  h: y2 - y1,
});
const node = (id, b, extra = {}) => ({
  packageName: pkg,
  resourceId: pkg + ':id/' + id,
  className: 'android.widget.TextView',
  enabled: true,
  visible: true,
  clickable: false,
  focused: false,
  text: '',
  desc: '',
  bounds: b,
  ...extra,
});
const collapsed = node('g3t', bounds(168, 2672, 900, 2780), { text: 'พิมพ์...' });
const header = [
  node('ap_', bounds(36, 24, 635, 132), { clickable: true }),
  node('zud', bounds(156, 30, 318, 81), { text: 'GGZ24' }),
  node('dm0', bounds(1250, 24, 1400, 132), { clickable: true }),
];
const editor = node('g7d', bounds(100, 2630, 1200, 2700), {
  className: 'android.widget.EditText',
  focused: true,
  text: 'คำถาม',
});
const send = node('tnl', bounds(1278, 2580, 1440, 2758), {
  className: 'android.widget.ImageView',
  clickable: true,
});
const modal = node('view_shadow', bounds(0, 0, 1440, 2580));
const room = [...header, collapsed],
  composer = [editor, send, modal];
test('recognizes collapsed LIVE and moved focused composer; no coordinate fallback', () => {
  assert.equal(selectChatNode(room, size), collapsed);
  assert.equal(focusedComposer(room, size), null);
  assert.equal(focusedComposer(composer, size), editor);
  const moved = { ...editor, bounds: bounds(100, 1400, 1200, 1470) };
  const movedSend = { ...send, bounds: bounds(1278, 1360, 1440, 1538) };
  assert.equal(verifiedSendTarget([moved, movedSend, modal], size, 'คำถาม').send, movedSend);
  assert.equal(selectChatNode([], size), null);
});
test('rejects search, other apps, ambiguous inputs, profile overlays and closed LIVE', () => {
  assert.equal(
    selectChatNode(
      [
        node('search_input', editor.bounds, {
          className: 'android.widget.EditText',
          focused: true,
          text: 'ค้นหา',
        }),
      ],
      size,
    ),
    null,
  );
  assert.equal(
    selectChatNode(
      room.map((n) => ({ ...n, packageName: 'com.android.chrome' })),
      size,
    ),
    null,
  );
  assert.equal(
    selectChatNode([...composer, { ...editor, resourceId: pkg + ':id/second' }], size),
    null,
  );
  assert.equal(selectChatNode([...room, node('qww', bounds(10, 1000, 1400, 2300))], size), null);
  assert.equal(
    selectChatNode(
      [...room, node('ended', bounds(10, 1000, 500, 1100), { text: 'LIVE has ended' })],
      size,
    ),
    null,
  );
  for (const extra of [
    { enabled: false },
    { visible: false },
    { password: true },
    { bounds: bounds(100, 2600, 1600, 2700) },
  ])
    assert.equal(focusedComposer([{ ...editor, ...extra }, send, modal], size), null);
});
test('never treats an unlabeled adjacent gift/share icon or saved point as send', () => {
  assert.equal(
    verifiedSendTarget(
      [editor, { ...send, resourceId: pkg + ':id/unknown' }, modal],
      size,
      'คำถาม',
    ),
    null,
  );
  assert.equal(verifiedSendTarget([editor, { ...send, desc: 'gift' }, modal], size, 'คำถาม'), null);
  assert.equal(verifiedSendTarget([...composer, { ...send }], size, 'คำถาม'), null);
  assert.equal(verifiedSendTarget(composer, size, 'ข้อความอื่น'), null);
  const empty = { ...editor, text: '' },
    inactive = { ...send, clickable: false };
  assert.equal(focusedComposer([empty, inactive, modal], size), empty);
  assert.equal(verifiedSendTarget([empty, inactive, modal], size, ''), null);
});
test('requires two matching fresh observations and follows a moved input', async () => {
  const moved = { ...collapsed, bounds: bounds(100, 2100, 1000, 2200) };
  const frames = [room, [...header, moved], [...header, moved]];
  assert.equal(
    (
      await stableTarget(
        async () => frames.shift(),
        (n) => selectChatNode(n, size),
      )
    ).target,
    moved,
  );
  await assert.rejects(
    stableTarget(
      async () => [],
      (n) => selectChatNode(n, size),
    ),
    /หยุด/,
  );
  let i = 0;
  await assert.rejects(
    stableTarget(
      async () => [
        ...header,
        { ...collapsed, bounds: bounds(100, 2000 + i++ * 100, 1000, 2050 + i * 100) },
      ],
      (n) => selectChatNode(n, size),
    ),
    /หยุด/,
  );
});
test('preparation opens only verified input once and never types or sends', async () => {
  const frames = [room, room, composer, composer],
    taps = [];
  const ready = await prepareComposer({
    size,
    read: async () => frames.shift(),
    tap: async (x, y) => taps.push([x, y]),
    pause: async () => {},
  });
  assert.equal(ready.target, editor);
  assert.deepEqual(taps, [[collapsed.bounds.cx, collapsed.bounds.cy]]);
  await assert.rejects(
    prepareComposer({
      size,
      read: async () => [],
      tap: async () => taps.push('bad'),
      pause: async () => {},
    }),
  );
  assert.equal(taps.length, 1);
});
