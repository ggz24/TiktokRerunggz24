import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePlan, planInstructions, PLAN_MODEL } from './plan-ai.mjs';

const chunks = [
  { start: 0, text: 'ไฟเบอร์รี่ 1 กล่องมี 30 ซอง' },
  { start: 60, text: 'ราคาโปรวันนี้ 150 บาท' },
];
const reply = (questions) => ({
  output: [
    { content: [{ type: 'output_text', text: JSON.stringify({ questions, reason: 'ok' }) }] },
  ],
});

test('plan is generated from the whole transcript in one request', async () => {
  const calls = [];
  const plan = await generatePlan(
    async (path, payload) => {
      calls.push({ path, payload });
      return reply([
        { at_seconds: 70, question: 'โปรนี้ถึงเมื่อไหร่คะ' },
        { at_seconds: 10, question: 'ในกล่องมีกี่ซองคะ' },
      ]);
    },
    { chunks, duration: 120, count: 5, minGap: 30, models: [PLAN_MODEL, 'gpt-4o-mini'] },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'responses');
  assert.equal(calls[0].payload.model, PLAN_MODEL);
  assert.equal(calls[0].payload.store, false);
  const input = JSON.parse(calls[0].payload.input);
  assert.equal(
    input.transcript,
    '[0:00] ไฟเบอร์รี่ 1 กล่องมี 30 ซอง\n[1:00] ราคาโปรวันนี้ 150 บาท',
  );
  assert.deepEqual(
    plan.items.map((i) => i.at),
    [10, 70],
  );
  assert.equal(plan.model, PLAN_MODEL);
});

test('falls back to the configured model only when the preferred one is unavailable', async () => {
  const seen = [];
  const plan = await generatePlan(
    async (_path, payload) => {
      seen.push(payload.model);
      if (payload.model === PLAN_MODEL) throw new Error('บริการ AI ตอบกลับ 404 (model_not_found)');
      return reply([{ at_seconds: 5, question: 'ราคาเท่าไหร่คะ' }]);
    },
    { chunks, duration: 120, models: [PLAN_MODEL, 'gpt-4o-mini'] },
  );
  assert.deepEqual(seen, [PLAN_MODEL, 'gpt-4o-mini']);
  assert.equal(plan.model, 'gpt-4o-mini');
  await assert.rejects(
    generatePlan(
      async () => {
        throw new Error('API key ไม่ถูกต้อง');
      },
      { chunks, duration: 120, models: [PLAN_MODEL, 'gpt-4o-mini'] },
    ),
    /API key/,
  );
});

test('silent clips and malformed answers are rejected before any question is used', async () => {
  await assert.rejects(
    generatePlan(async () => reply([]), { chunks: [{ start: 0, text: ' ' }], duration: 60 }),
    /ไม่พบบทพูด/,
  );
  await assert.rejects(
    generatePlan(
      async () => ({ output: [{ content: [{ type: 'output_text', text: 'not json' }] }] }),
      { chunks, duration: 120 },
    ),
    /รูปแบบ/,
  );
  assert.match(planInstructions(5, 90), /ไม่เกิน 5 ข้อ/);
});
