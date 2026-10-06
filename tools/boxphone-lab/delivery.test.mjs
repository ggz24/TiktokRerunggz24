import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typedEditor, currentSendTarget, deliveryObservation } from './delivery.mjs';
const edit = {
  className: 'android.widget.EditText',
  enabled: true,
  focused: true,
  text: 'ทดสอบ',
  packageName: 'app',
  resourceId: 'app:id/input',
  bounds: { cx: 150, cy: 700, h: 50 },
};
const send = {
  className: 'android.widget.Button',
  enabled: true,
  clickable: true,
  text: 'ส่ง',
  desc: '',
  packageName: 'app',
  resourceId: 'app:id/send',
  bounds: { cx: 300, cy: 700, h: 50 },
};
const comment = {
  className: 'android.widget.TextView',
  text: 'ทดสอบ',
  packageName: 'app',
  resourceId: 'app:id/comment_text',
};
test('requires exact text and focused editor', () => {
  assert.equal(typedEditor([edit], 'ผิดข้อความ'), null);
  assert.equal(typedEditor([{ ...edit, focused: false }], 'ทดสอบ'), null);
  assert.equal(typedEditor([edit], 'ทดสอบ'), edit);
});
test('current send button must be unique, labeled and aligned to composer', () => {
  assert.equal(currentSendTarget([send], edit), send);
  assert.equal(currentSendTarget([{ ...send, text: '', resourceId: 'unknown' }], edit), null);
  assert.equal(currentSendTarget([{ ...send, bounds: { ...send.bounds, cy: 900 } }], edit), null);
  assert.equal(currentSendTarget([send, { ...send }], edit), null);
  assert.equal(currentSendTarget([{ ...send, desc: 'gift' }], edit), null);
});
test('input clearing alone and old comments never verify delivery', () => {
  const empty = { ...edit, text: '' };
  assert.equal(deliveryObservation([edit], [empty], edit, 'ทดสอบ'), 'unverified');
  assert.equal(deliveryObservation([edit, comment], [empty, comment], edit, 'ทดสอบ'), 'unverified');
  assert.equal(deliveryObservation([edit], [edit, comment], edit, 'ทดสอบ'), 'still_in_input');
  assert.equal(deliveryObservation([edit], [empty, comment], edit, 'ทดสอบ'), 'observed_local');
  assert.equal(
    deliveryObservation([edit], [empty, { ...comment, resourceId: 'title' }], edit, 'ทดสอบ'),
    'unverified',
  );
});
test('observed TikTok resource follows moved button and handles direction marks', () => {
  const input = {
    ...edit,
    resourceId: 'com.zhiliaoapp.musically:id/g7d',
    packageName: 'com.zhiliaoapp.musically',
    bounds: { cx: 600, cy: 2670, h: 70 },
  };
  const button = {
    ...send,
    text: '',
    resourceId: 'com.zhiliaoapp.musically:id/tnl',
    packageName: input.packageName,
    bounds: { cx: 1359, cy: 2670, h: 178 },
  };
  assert.equal(currentSendTarget([button], input), button);
  const newComment = {
    ...comment,
    resourceId: 'com.zhiliaoapp.musically:id/ecp',
    packageName: input.packageName,
    text: '\u200eทดสอบ',
  };
  assert.equal(deliveryObservation([input], [newComment], input, 'ทดสอบ'), 'observed_local');
});
