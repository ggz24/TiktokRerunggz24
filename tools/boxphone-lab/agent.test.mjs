import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWED_ACTIONS, createAgent, validRemoteUrl } from './agent.mjs';

const agentToken = 'a'.repeat(40);
const bridgeToken = 'b'.repeat(40);
const reply = (status, body = '') => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  json: async () => JSON.parse(body),
});

function fixture(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  const agent = createAgent({
    remoteUrl: 'https://live.example/live',
    agentToken,
    bridgeToken,
    fetchImpl,
    sleep: async () => {},
  });
  return { agent, calls };
}

test('remote URL must be https without credentials; tokens must be long enough', () => {
  assert.equal(validRemoteUrl('https://ggz24.com/live'), true);
  assert.equal(validRemoteUrl('http://localhost:3100'), true);
  assert.equal(validRemoteUrl('http://ggz24.com/live'), false);
  assert.equal(validRemoteUrl('https://user:pw@ggz24.com'), false);
  assert.equal(validRemoteUrl('https://ggz24.com/live?x=1'), false);
  assert.throws(
    () => createAgent({ remoteUrl: 'https://x.example', agentToken: 'short', bridgeToken }),
    /at least 32/,
  );
  assert.throws(
    () => createAgent({ remoteUrl: 'https://x.example', agentToken, bridgeToken: '' }),
    /BRIDGE_TOKEN/,
  );
});

test('a job runs only against the fixed local bridge, with the bridge token added locally', async () => {
  const { agent, calls } = fixture(async () => reply(200, '{"devices":[]}'));
  const result = await agent.runJob({
    id: '1',
    action: 'devices',
    method: 'POST',
    owner: 'adminggz24',
    body: '{}',
  });
  assert.deepEqual(result, { status: 200, body: '{"devices":[]}' });
  assert.equal(calls[0].url, 'http://127.0.0.1:8767/api/devices');
  assert.equal(calls[0].options.headers['x-boxphone-bridge-token'], bridgeToken);
  assert.equal(calls[0].options.headers['x-livehub-owner'], 'adminggz24');
  const health = await agent.runJob({
    id: '2',
    action: 'health',
    method: 'GET',
    owner: 'adminggz24',
    body: null,
  });
  assert.equal(health.status, 200);
  assert.equal(calls[1].url, 'http://127.0.0.1:8767/health');
});

test('unknown actions, odd methods and bad owners are refused without touching the bridge', async () => {
  const { agent, calls } = fixture(async () => reply(200, '{}'));
  for (const job of [
    { id: '1', action: 'shell', method: 'POST', owner: 'o', body: '{}' },
    { id: '1', action: '../../etc/passwd', method: 'POST', owner: 'o', body: '{}' },
    { id: '1', action: 'devices', method: 'GET', owner: 'o', body: null },
    { id: '1', action: 'devices', method: 'DELETE', owner: 'o', body: null },
    { id: '1', action: 'devices', method: 'POST', owner: '', body: '{}' },
    { id: 5, action: 'devices', method: 'POST', owner: 'o', body: '{}' },
    null,
  ])
    assert.equal((await agent.runJob(job)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(ALLOWED_ACTIONS.has('transcribe-video'), false); // those are resolved by the web service, not here
});

test('a bridge that is down gives a clear error instead of hanging', async () => {
  const { agent } = fixture(async () => {
    throw new Error('ECONNREFUSED');
  });
  const result = await agent.runJob({
    id: '1',
    action: 'devices',
    method: 'POST',
    owner: 'o',
    body: '{}',
  });
  assert.equal(result.status, 503);
  assert.match(JSON.parse(result.body).error, /Boxphone/);
});

test('polling fetches a job, runs it and posts the result with the agent token', async () => {
  const { agent, calls } = fixture(async (url) => {
    if (url.endsWith('/api/boxphone-agent/next'))
      return reply(
        200,
        JSON.stringify({ id: 'j1', action: 'devices', method: 'POST', owner: 'o', body: '{}' }),
      );
    if (url.endsWith('/api/api/devices') || url.endsWith('/api/devices'))
      return reply(200, '{"devices":[1]}');
    return reply(200, '{"accepted":true}');
  });
  assert.equal(await agent.pollOnce(), true);
  for (let i = 0; i < 20 && agent.active(); i += 1) await new Promise((r) => setTimeout(r, 5));
  const posted = calls.find((c) => c.url === 'https://live.example/live/api/boxphone-agent/result');
  assert.ok(posted);
  assert.equal(posted.options.headers.authorization, `Bearer ${agentToken}`);
  assert.deepEqual(JSON.parse(posted.options.body), {
    id: 'j1',
    status: 200,
    body: '{"devices":[1]}',
  });
  assert.equal(calls[0].options.headers.authorization, `Bearer ${agentToken}`);
});

test('an idle poll returns false and a refused token backs off', async () => {
  const idle = fixture(async () => reply(204));
  assert.equal(await idle.agent.pollOnce(), false);
  const refused = fixture(async () => reply(401));
  assert.equal(await refused.agent.pollOnce(), false);
});
