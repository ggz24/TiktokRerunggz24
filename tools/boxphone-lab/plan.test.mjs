import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkStarts,
  defaultQuestionCount,
  formatClock,
  normalizePlan,
  parseClock,
  planDue,
  planFromText,
  planToText,
  playbackPosition,
  transcriptForPlan,
} from './plan.mjs';

test('clock text round trips and rejects junk', () => {
  assert.equal(formatClock(75), '1:15');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(parseClock('1:15'), 75);
  assert.equal(parseClock('1:02:05'), 3725);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock('1:2:3:4'), null);
});

test('chunks cover the whole clip and skip a tail shorter than 5 seconds', () => {
  assert.deepEqual(chunkStarts(125), [0, 60, 120]);
  assert.deepEqual(chunkStarts(122), [0, 60]);
  assert.deepEqual(chunkStarts(3), []);
  assert.equal(defaultQuestionCount(600), 4);
  assert.equal(defaultQuestionCount(3600), 15);
  assert.equal(defaultQuestionCount(100000), 30);
});

test('transcript keeps order, drops silence and labels each window', () => {
  const text = transcriptForPlan([
    { start: 60, text: ' ราคา  150 ' },
    { start: 0, text: 'สวัสดี' },
    { start: 120, text: ' ' },
  ]);
  assert.equal(text, '[0:00] สวัสดี\n[1:00] ราคา 150');
});

test('plan rows are bounded, unique, spaced and sorted', () => {
  const plan = normalizePlan(
    [
      { at_seconds: 400, question: 'มีกี่รสคะ' },
      { at_seconds: 10, question: 'ราคาเท่าไหร่คะ' },
      { at_seconds: 20, question: 'ส่งฟรีไหมคะ' }, // inside the 120s gap after the first
      { at_seconds: 5000, question: 'ท้ายคลิปมีของแถมไหมคะ' }, // clamped to just before the end
      { at_seconds: 300, question: 'ราคาเท่าไหร่คะ' }, // duplicate wording
      { at_seconds: -3, question: 'ติดลบ' },
      { at_seconds: 200, question: 'x'.repeat(130) },
      { at_seconds: 250, question: '   ' },
    ],
    { duration: 600, count: 10, minGap: 120 },
  );
  assert.deepEqual(
    plan.map((p) => p.at),
    [10, 400, 595],
  );
  assert.equal(plan[0].text, 'ราคาเท่าไหร่คะ');
});

test('plan size is capped by count and avoids earlier questions', () => {
  const topics = [
    'ราคาเท่าไหร่',
    'มีกี่รสชาติ',
    'ส่งฟรีไหม',
    'ทานตอนไหนดี',
    'เก็บได้นานแค่ไหน',
    'มีของแถมหรือเปล่า',
  ];
  const rows = topics.map((topic, i) => ({ at: i * 100, text: `${topic}` }));
  assert.equal(normalizePlan(rows, { duration: 5000, count: 3, minGap: 0 }).length, 3);
  assert.equal(normalizePlan(rows, { duration: 5000, count: 30, minGap: 0 }).length, 6);
  assert.equal(
    normalizePlan([{ at: 5, text: 'ไฟเบอร์รี่ราคาเท่าไหร่คะ' }], {
      duration: 100,
      previous: ['ไฟเบอร์รี่ราคาเท่าไหร่คะ'],
    }).length,
    0,
  );
});

test('editable text form keeps valid lines only', () => {
  const text = '0:30 | ราคาเท่าไหร่คะ\nไม่มีเวลา\n5:00 | มีกี่รสคะ\nxx | ผิดเวลา';
  const plan = planFromText(text, { duration: 600, minGap: 60 });
  assert.deepEqual(plan, [
    { at: 30, text: 'ราคาเท่าไหร่คะ' },
    { at: 300, text: 'มีกี่รสคะ' },
  ]);
  assert.equal(planToText(plan), '0:30 | ราคาเท่าไหร่คะ\n5:00 | มีกี่รสคะ');
});

test('playback position loops and accounts for the allowance', () => {
  const start = Date.parse('2026-10-06T10:00:00Z');
  assert.equal(playbackPosition(start, start + 5000, 600), null); // before the first played second
  assert.deepEqual(playbackPosition(start, start + 108_000, 600), { loop: 0, position: 100 });
  assert.deepEqual(playbackPosition(start, start + 708_000, 600), { loop: 1, position: 100 });
  assert.equal(playbackPosition(start, start + 108_000, 0), null);
});

test('due questions are those reached, unused and not stale', () => {
  const start = Date.parse('2026-10-06T10:00:00Z');
  const items = [
    { at: 30, text: 'ก' },
    { at: 100, text: 'ข' },
    { at: 400, text: 'ค' },
  ];
  const used = new Set();
  // 508s after start -> position 500: 'ค' is due, 'ข' is 400s old (stale), 'ก' stale
  const late = planDue(items, { startedAt: start, now: start + 508_000, duration: 600 }, used);
  assert.deepEqual(
    late.due.map((d) => d.text),
    ['ค'],
  );
  assert.deepEqual(
    late.stale.map((d) => d.text),
    ['ก', 'ข'],
  );
  // at position 120 only 'ก' (90s) and 'ข' (20s) are reached
  const early = planDue(items, { startedAt: start, now: start + 128_000, duration: 600 }, used);
  assert.deepEqual(
    early.due.map((d) => d.id),
    ['0:0', '0:1'],
  );
  used.add('0:0');
  assert.deepEqual(
    planDue(items, { startedAt: start, now: start + 128_000, duration: 600 }, used).due.map(
      (d) => d.id,
    ),
    ['0:1'],
  );
  // second loop: the same row has a new id, so it can be asked again later
  assert.deepEqual(
    planDue(items, { startedAt: start, now: start + 758_000, duration: 600 }, used).due.map(
      (d) => d.id,
    ),
    ['1:0', '1:1'],
  );
});
