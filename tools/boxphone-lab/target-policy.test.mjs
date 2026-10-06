import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liveUrl,
  channelVisible,
  bindingMatches,
  groupDevices,
  nativeProfileIdentity,
  nativeLiveHeader,
  nativeLiveComposer,
  verifiedComposerVisible,
} from './target-policy.mjs';
const node = (text, y, extra = {}) => ({
  text,
  desc: '',
  packageName: 'com.zhiliaoapp.musically',
  enabled: true,
  bounds: { cy: y, y2: y + 10 },
  ...extra,
});
const live = node('LIVE', 50);
test('only a channel handle creates a fixed TikTok LIVE URL', () => {
  assert.equal(liveUrl('shop_24'), 'https://www.tiktok.com/@shop_24/live');
  for (const invalid of ['a;reboot', 'a/b', 'https://evil.test', 'a b', ''])
    assert.throws(() => liveUrl(invalid));
});
test('a matching viewer comment or profile cannot confirm the target LIVE', () => {
  assert.equal(
    channelVisible([live, node('@shop_24', 100), node('Add a comment', 900)], 'shop_24', 1000),
    true,
  );
  assert.equal(
    channelVisible([node('@shop_24', 100), node('Add a comment', 900)], 'shop_24', 1000),
    false,
  );
  assert.equal(
    channelVisible(
      [node('@other', 100), node('@shop_24', 700), node('Add a comment', 900)],
      'shop_24',
      1000,
    ),
    false,
  );
  assert.equal(channelVisible([node('@shop_24', 100)], 'shop_24', 1000), false);
  assert.equal(
    channelVisible(
      [node('@shop_24', 100), node('Add a comment', 900), node('LIVE has ended', 400)],
      'shop_24',
      1000,
    ),
    false,
  );
  assert.equal(
    channelVisible(
      [node('@shop_24', 100, { packageName: 'com.android.chrome' }), node('Add a comment', 900)],
      'shop_24',
      1000,
    ),
    false,
  );
});
test('a queued job is invalid after reassignment or a new stream', () => {
  const job = { target: { accountId: 'channel-a', key: 'room-1' } };
  assert.equal(bindingMatches(job, 'channel-a', { key: 'room-1' }), true);
  assert.equal(bindingMatches(job, 'channel-b', { key: 'room-1' }), false);
  assert.equal(bindingMatches(job, 'channel-a', { key: 'room-2' }), false);
});
test('multiple phones are grouped by their own live verified channel only', () => {
  const channels = [
    { id: 'a', connected: true, status: 'live' },
    { id: 'b', connected: true, status: 'idle' },
    { id: 'c', connected: false, status: 'live' },
  ];
  const groups = groupDevices(
    ['p1', 'p2', 'p3', 'p4', 'p5'],
    { p1: 'a', p2: 'a', p3: 'b', p4: 'c' },
    channels,
  );
  assert.deepEqual(
    groups.map((g) => [g.channel.id, g.serials]),
    [['a', ['p1', 'p2']]],
  );
});

test('the observed host card binds its exact username and display name, never a viewer comment', () => {
  const bounds = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 });
  const card = [
    node('', 1603, {
      resourceId: 'com.zhiliaoapp.musically:id/qww',
      bounds: bounds(48, 1436, 576, 1770),
    }),
    node('GGZ24', 1514, {
      resourceId: 'com.zhiliaoapp.musically:id/o__',
      bounds: bounds(312, 1463, 576, 1564),
    }),
    node('pimnatcha66', 1598, {
      resourceId: 'com.zhiliaoapp.musically:id/zud',
      bounds: bounds(312, 1570, 565, 1625),
    }),
  ];
  assert.deepEqual(nativeProfileIdentity(card), {
    displayName: 'GGZ24',
    handle: 'pimnatcha66',
    packageName: 'com.zhiliaoapp.musically',
  });
  assert.equal(
    nativeProfileIdentity([
      card[0],
      card[1],
      node('pimnatcha66', 2500, {
        resourceId: 'com.zhiliaoapp.musically:id/zud',
        bounds: bounds(50, 2450, 500, 2550),
      }),
    ]),
    null,
  );
  assert.equal(nativeProfileIdentity([...card, card[2]]), null);
  const room = [
    node('', 78, {
      resourceId: 'com.zhiliaoapp.musically:id/ap_',
      clickable: true,
      bounds: bounds(36, 24, 635, 132),
    }),
    node('GGZ24', 56, {
      resourceId: 'com.zhiliaoapp.musically:id/zud',
      bounds: bounds(156, 30, 318, 81),
    }),
    node('', 78, { resourceId: 'com.zhiliaoapp.musically:id/dm0', clickable: true }),
    node('พิมพ์...', 2726, { resourceId: 'com.zhiliaoapp.musically:id/g3t' }),
  ];
  assert.equal(nativeLiveHeader(room, 2960)?.displayName, 'GGZ24');
  assert.equal(
    nativeLiveHeader(
      room.filter((n) => !n.resourceId.endsWith('/dm0')),
      2960,
    ),
    null,
  );
  assert.equal(nativeLiveHeader([...room, node('LIVE has ended', 1500)], 2960), null);
  assert.equal(
    nativeLiveHeader(
      room.map((n) => ({ ...n, packageName: 'com.android.chrome' })),
      2960,
    ),
    null,
  );
});
test('the LIVE composer requires fresh host verification and its observed modal, editor and send button', () => {
  const pkg = 'com.zhiliaoapp.musically';
  const edit = node('question', 2673, {
    className: 'android.widget.EditText',
    focused: true,
    resourceId: pkg + ':id/g7d',
    bounds: { cy: 2673, cx: 630, h: 70, y2: 2708 },
  });
  const send = node('', 2670, {
    clickable: true,
    resourceId: pkg + ':id/tnl',
    bounds: { cy: 2670, cx: 1359, h: 178, y2: 2759 },
  });
  const modal = node('', 1319, { resourceId: pkg + ':id/view_shadow' });
  const nodes = [edit, send, modal],
    identity = { displayName: 'GGZ24', packageName: pkg };
  assert.ok(nativeLiveComposer(nodes, 2960));
  assert.equal(verifiedComposerVisible(nodes, identity, 2960, 1000, 2000), true);
  assert.equal(verifiedComposerVisible(nodes, identity, 2960, 1000, 31001), false);
  assert.equal(verifiedComposerVisible(nodes, undefined, 2960, 1000, 2000), false);
  assert.equal(
    verifiedComposerVisible(
      nodes,
      { ...identity, packageName: 'com.android.chrome' },
      2960,
      1000,
      2000,
    ),
    false,
  );
  assert.equal(nativeLiveComposer([edit, send], 2960), null);
  assert.equal(nativeLiveComposer([{ ...edit, focused: false }, send, modal], 2960), null);
  assert.equal(nativeLiveComposer([...nodes, node('LIVE has ended', 1500)], 2960), null);
});
