import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentForSerial,
  agentOnline,
  completeJob,
  dropAgent,
  listDevices,
  nextJob,
  onlineAgents,
  resetRelay,
  submitForSerial,
  submitJob,
  type AgentIdentity,
} from './boxphone-relay';

const pc1: AgentIdentity = { id: 'agent-1', owner: 'owner', name: 'คอมห้องไลฟ์' };
const pc2: AgentIdentity = { id: 'agent-2', owner: 'owner', name: 'คอมสำรอง' };
const stranger: AgentIdentity = { id: 'agent-9', owner: 'someone', name: 'ของคนอื่น' };
const job = { action: 'devices', method: 'POST' as const, owner: 'owner', body: '{}' };

/** A fake computer: answers every job it receives with the given handler. */
function runAgent(
  identity: AgentIdentity,
  handler: (j: { action: string; body: string | null }) => { status: number; body: string },
) {
  let stopped = false;
  const seen: string[] = [];
  void (async () => {
    while (!stopped) {
      const next = await nextJob(identity, 50);
      if (!next) continue;
      seen.push(next.action);
      completeJob(identity.id, next.id, handler(next));
    }
  })();
  return {
    seen,
    stop: () => {
      stopped = true;
    },
  };
}

test('jobs fail fast while the computer has not connected', async () => {
  resetRelay();
  assert.equal(agentOnline('owner'), false);
  await assert.rejects(submitJob('agent-1', job), /ยังไม่เชื่อมต่อ/);
});

test('a waiting agent receives its job and only that agent can answer it', async () => {
  resetRelay();
  const waiting = nextJob(pc1, 1000);
  const result = submitJob('agent-1', job);
  const received = await waiting;
  assert.ok(received);
  assert.equal(completeJob('agent-2', received.id, { status: 200, body: 'forged' }), false);
  assert.equal(completeJob('agent-1', received.id, { status: 200, body: '{"ok":true}' }), true);
  assert.deepEqual(await result, { status: 200, body: '{"ok":true}' });
  assert.equal(completeJob('agent-1', received.id, { status: 200, body: '{}' }), false); // accepted once
});

test("one owner cannot reach another owner's computer", async () => {
  resetRelay();
  await nextJob(stranger, 10);
  await assert.rejects(submitJob('agent-9', job), /ยังไม่เชื่อมต่อ/); // job.owner is "owner", the agent belongs to "someone"
  assert.deepEqual(onlineAgents('owner'), []);
  assert.equal(onlineAgents('someone').length, 1);
});

test('queued jobs go to the right computer in order and a silent computer times out', async () => {
  resetRelay();
  await nextJob(pc1, 10);
  const a = submitJob('agent-1', { ...job, action: 'screenshot' });
  const b = submitJob('agent-1', { ...job, action: 'detect-chat' });
  const one = await nextJob(pc1, 100);
  const two = await nextJob(pc1, 100);
  assert.deepEqual([one?.action, two?.action], ['screenshot', 'detect-chat']);
  completeJob('agent-1', one!.id, { status: 200, body: '1' });
  completeJob('agent-1', two!.id, { status: 200, body: '2' });
  assert.equal((await a).body, '1');
  assert.equal((await b).body, '2');
  const slow = submitJob('agent-1', job, 30);
  const late = await nextJob(pc1, 100);
  await assert.rejects(slow, /ไม่ตอบกลับ/);
  assert.equal(completeJob('agent-1', late!.id, { status: 200, body: '{}' }), false);
});

test('phones from several computers are merged, labelled, and routed to the computer that holds them', async () => {
  resetRelay();
  const a = runAgent(pc1, (j) =>
    j.action === 'devices'
      ? {
          status: 200,
          body: JSON.stringify({
            devices: [
              { serial: 'S-A2', xiaoweiNumber: 42 },
              { serial: 'S-A1', xiaoweiNumber: 40 },
            ],
          }),
        }
      : { status: 200, body: JSON.stringify({ from: 'pc1', action: j.action }) },
  );
  const b = runAgent(pc2, (j) =>
    j.action === 'devices'
      ? { status: 200, body: JSON.stringify({ devices: [{ serial: 'S-B1', xiaoweiNumber: 41 }] }) }
      : { status: 200, body: JSON.stringify({ from: 'pc2', action: j.action }) },
  );
  await new Promise((r) => setTimeout(r, 80));
  const listed = await listDevices('owner');
  assert.deepEqual(
    listed.devices.map((d) => [d.serial, d.computerName]),
    [
      ['S-A1', 'คอมห้องไลฟ์'],
      ['S-B1', 'คอมสำรอง'],
      ['S-A2', 'คอมห้องไลฟ์'],
    ],
  );
  assert.deepEqual(
    listed.computers.map((c) => [c.name, c.ok, c.count]),
    [
      ['คอมห้องไลฟ์', true, 2],
      ['คอมสำรอง', true, 1],
    ],
  );
  assert.equal(agentForSerial('owner', 'S-B1'), 'agent-2');
  const sent = await submitForSerial('owner', 'S-B1', {
    action: 'send',
    method: 'POST',
    body: '{"serial":"S-B1"}',
  });
  assert.equal(JSON.parse(sent.body).from, 'pc2');
  const shot = await submitForSerial('owner', 'S-A1', {
    action: 'screenshot',
    method: 'POST',
    body: '{}',
  });
  assert.equal(JSON.parse(shot.body).from, 'pc1');
  await assert.rejects(
    submitForSerial('owner', 'S-NOPE', { action: 'send', method: 'POST', body: '{}' }),
    /ไม่พบโทรศัพท์/,
  );
  a.stop();
  b.stop();
  await new Promise((r) => setTimeout(r, 120));
});

test('one computer failing does not hide the phones of the others; all failing is an error', async () => {
  resetRelay();
  const a = runAgent(pc1, () => ({
    status: 200,
    body: JSON.stringify({ devices: [{ serial: 'S-A1' }] }),
  }));
  const b = runAgent(pc2, () => ({ status: 503, body: JSON.stringify({ error: 'ADB ไม่ตอบ' }) }));
  await new Promise((r) => setTimeout(r, 80));
  const listed = await listDevices('owner');
  assert.equal(listed.devices.length, 1);
  assert.deepEqual(
    listed.computers.map((c) => c.ok),
    [true, false],
  );
  a.stop();
  b.stop();
  await new Promise((r) => setTimeout(r, 120));
  resetRelay();
  const c = runAgent(pc2, () => ({ status: 503, body: JSON.stringify({ error: 'ADB ไม่ตอบ' }) }));
  await new Promise((r) => setTimeout(r, 80));
  await assert.rejects(listDevices('owner'), /ADB ไม่ตอบ/);
  c.stop();
  await new Promise((r) => setTimeout(r, 120));
});

test('removing a computer fails its pending jobs at once and forgets its phones', async () => {
  resetRelay();
  const a = runAgent(pc1, () => ({
    status: 200,
    body: JSON.stringify({ devices: [{ serial: 'S-A1' }] }),
  }));
  await new Promise((r) => setTimeout(r, 80));
  await listDevices('owner');
  a.stop();
  await new Promise((r) => setTimeout(r, 120));
  await nextJob(pc1, 10);
  const pending = submitJob('agent-1', job, 5000);
  const rejected = assert.rejects(pending, /ตัดการเชื่อมต่อ/);
  dropAgent('agent-1');
  await rejected;
  assert.equal(agentForSerial('owner', 'S-A1'), undefined);
});

test('oversized bodies and a flood of jobs are refused', async () => {
  resetRelay();
  await nextJob(pc1, 10);
  await assert.rejects(
    submitJob('agent-1', { ...job, body: 'x'.repeat(49 * 1024 * 1024) }),
    /ยาวเกินไป/,
  );
  const open = Array.from({ length: 50 }, () =>
    submitJob('agent-1', job, 50).catch(() => undefined),
  );
  await assert.rejects(submitJob('agent-1', job), /ค้างมาก/);
  await Promise.all(open);
});
