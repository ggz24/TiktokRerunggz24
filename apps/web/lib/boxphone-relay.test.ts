import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOnline, completeJob, nextJob, resetRelay, submitJob } from './boxphone-relay';

const job = { action: 'devices', method: 'POST' as const, owner: 'owner', body: '{}' };

test('jobs fail fast while no agent has connected', async () => {
  resetRelay();
  assert.equal(agentOnline(), false);
  await assert.rejects(submitJob(job), /ยังไม่เชื่อมต่อ/);
});

test('a waiting agent receives a job and its result reaches the caller', async () => {
  resetRelay();
  const waiting = nextJob(1000); // the agent connects first
  const result = submitJob(job);
  const received = await waiting;
  assert.ok(received);
  assert.equal(received.action, 'devices');
  assert.equal(received.owner, 'owner');
  assert.equal(completeJob(received.id, { status: 200, body: '{"ok":true}' }), true);
  assert.deepEqual(await result, { status: 200, body: '{"ok":true}' });
  assert.equal(completeJob(received.id, { status: 200, body: '{}' }), false); // a result is accepted once
});

test('jobs queued while the agent is busy are delivered in order, once', async () => {
  resetRelay();
  const first = nextJob(10); // makes the agent count as online
  await first;
  const a = submitJob({ ...job, action: 'screenshot' });
  const b = submitJob({ ...job, action: 'detect-chat' });
  const one = await nextJob(100);
  const two = await nextJob(100);
  assert.deepEqual([one?.action, two?.action], ['screenshot', 'detect-chat']);
  assert.equal(await nextJob(10), null); // nothing left, the poll just times out
  completeJob(one!.id, { status: 200, body: '1' });
  completeJob(two!.id, { status: 200, body: '2' });
  assert.equal((await a).body, '1');
  assert.equal((await b).body, '2');
});

test('a job the agent never answers times out and cannot be completed later', async () => {
  resetRelay();
  await nextJob(10);
  const slow = submitJob(job, 30);
  const received = await nextJob(100);
  await assert.rejects(slow, /ไม่ตอบกลับ/);
  assert.equal(completeJob(received!.id, { status: 200, body: '{}' }), false);
});

test('oversized bodies and a flood of jobs are refused', async () => {
  resetRelay();
  await nextJob(10);
  await assert.rejects(submitJob({ ...job, body: 'x'.repeat(49 * 1024 * 1024) }), /ยาวเกินไป/);
  const open = Array.from({ length: 50 }, () => submitJob(job, 50).catch(() => undefined));
  await assert.rejects(submitJob(job), /ค้างมาก/);
  await Promise.all(open);
});
