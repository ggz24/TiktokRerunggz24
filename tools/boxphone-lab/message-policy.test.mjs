import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  similar,
  uniqueQuestions,
  assignQuestions,
  waitForSend,
} from './message-policy.mjs';
test('ignore spacing/punctuation/polite suffix in duplicate detection', () => {
  assert.equal(normalize('ราคาเท่าไรครับ?'), normalize('ราคาเท่าไรคะ'));
  assert.ok(similar('มีสีอะไรบ้างครับ', 'มีสีอะไรบ้างคะ?'));
});
test('different meaningful questions stay distinct', () =>
  assert.equal(similar('ต้องใช้ไฟแรงแค่ไหน', 'ส่วนผสมแต่ละอย่างกี่กรัม'), false));
test('reject previous and repeated candidates without filling with copies', () => {
  assert.deepEqual(
    uniqueQuestions(['ราคาเท่าไรคะ', 'มีกี่สีครับ', 'มีกี่สีคะ', '  ', null], ['ราคาเท่าไรครับ']),
    ['มีกี่สีครับ'],
  );
});
test('one different message per unique serial, never cycle questions', () => {
  assert.deepEqual(assignQuestions(['มีกี่สีครับ', 'ส่งภายในกี่วันครับ'], ['a', 'b', 'a', 'c']), [
    { serial: 'a', text: 'มีกี่สีครับ' },
    { serial: 'b', text: 'ส่งภายในกี่วันครับ' },
  ]);
  assert.deepEqual(assignQuestions([], ['a']), []);
  assert.deepEqual(assignQuestions(['หนึ่ง'], []), []);
});
test('global and device cooldowns both enforced', () => {
  assert.equal(waitForSend(1000000, 0, 0), 0);
  assert.equal(waitForSend(1010000, 1000000, 0), 20000);
  assert.equal(waitForSend(1040000, 1000000, 1000000), 80000);
  assert.equal(waitForSend(1200000, 1000000, 1000000), 0);
});
