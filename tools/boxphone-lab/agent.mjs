import { fileURLToPath } from 'node:url';

/**
 * Runs on the computer that holds the phones. It connects OUT to the hosted Live Hub, waits for a job,
 * runs only the fixed Boxphone actions against the local bridge, and posts the result back.
 * No inbound port is opened and the bridge token never leaves this computer.
 */
export const ALLOWED_ACTIONS = new Set([
  'health',
  'ai-settings',
  'devices',
  'screenshot',
  'screen-size',
  'detect-chat',
  'prepare-chat',
  'check-keyboard',
  'setup-keyboard',
  'send',
  'transcribe',
  'questions',
  'plan-questions',
  'open-live',
  'check-live',
]);
const MAX_RESULT_CHARS = 48 * 1024 * 1024;
const MAX_PARALLEL = 6;

export function validRemoteUrl(value) {
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return (
      (url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function createAgent({
  remoteUrl,
  agentToken,
  bridgeToken,
  bridgeUrl = 'http://127.0.0.1:8767',
  fetchImpl = fetch,
  log = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollTimeoutMs = 40000,
}) {
  if (!validRemoteUrl(remoteUrl))
    throw new Error('BOXPHONE_REMOTE_URL must be an https URL without credentials');
  if (!agentToken || agentToken.length < 32)
    throw new Error('BOXPHONE_AGENT_TOKEN must be at least 32 characters');
  if (!bridgeToken) throw new Error('BOXPHONE_BRIDGE_TOKEN is required');
  const base = remoteUrl.replace(/\/$/, '');
  const auth = { authorization: `Bearer ${agentToken}` };
  let running = 0;
  let stopped = false;

  /** Execute one job against the local bridge. Anything outside the fixed action list is refused. */
  async function runJob(job) {
    const ok =
      job &&
      typeof job.id === 'string' &&
      ALLOWED_ACTIONS.has(job.action) &&
      typeof job.owner === 'string' &&
      job.owner.length > 0 &&
      job.owner.length <= 200 &&
      (job.body === null || typeof job.body === 'string') &&
      (job.method === 'GET' ? job.action === 'health' : job.method === 'POST');
    if (!ok) return { status: 400, body: JSON.stringify({ error: 'คำสั่งไม่ถูกต้อง' }) };
    try {
      const response = await fetchImpl(
        `${bridgeUrl}/${job.action === 'health' ? 'health' : 'api/' + job.action}`,
        {
          method: job.method,
          headers: {
            'content-type': 'application/json',
            'x-boxphone-bridge-token': bridgeToken,
            'x-lab-token': bridgeToken,
            'x-livehub-owner': job.owner,
          },
          body: job.method === 'POST' ? (job.body ?? '{}') : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(120000),
        },
      );
      const text = await response.text();
      if (text.length > MAX_RESULT_CHARS)
        return { status: 502, body: JSON.stringify({ error: 'ผลลัพธ์ใหญ่เกินไป' }) };
      return { status: response.status, body: text };
    } catch {
      return {
        status: 503,
        body: JSON.stringify({
          error: 'ตัวเชื่อม Boxphone ในคอมไม่ตอบ เปิด Start-Boxphone.cmd ใหม่',
        }),
      };
    }
  }

  async function report(id, result) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/api/boxphone-agent/result`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ id, status: result.status, body: result.body }),
          signal: AbortSignal.timeout(60000),
        });
        if (response.ok) return true;
      } catch {
        /* retry */
      }
      await sleep(1000);
    }
    return false;
  }

  async function handle(job) {
    running += 1;
    try {
      const result = await runJob(job);
      if (!(await report(job?.id, result))) log('could not report a result to Live Hub');
    } finally {
      running -= 1;
    }
  }

  /** One poll. Returns true when a job was received. */
  async function pollOnce() {
    const response = await fetchImpl(`${base}/api/boxphone-agent/next`, {
      headers: auth,
      signal: AbortSignal.timeout(pollTimeoutMs),
    });
    if (response.status === 204) return false;
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      log(
        `Live Hub refused the agent (${response.status}); check BOXPHONE_AGENT_TOKEN and BOXPHONE_REMOTE`,
      );
      await sleep(30000);
      return false;
    }
    if (!response.ok) {
      await sleep(5000);
      return false;
    }
    const job = await response.json();
    void handle(job);
    return true;
  }

  async function start() {
    let failures = 0;
    while (!stopped) {
      try {
        while (running >= MAX_PARALLEL && !stopped) await sleep(200);
        await pollOnce();
        failures = 0;
      } catch {
        failures += 1;
        if (failures === 1 || failures % 20 === 0) log('Live Hub is not reachable; retrying');
        await sleep(Math.min(30000, 2000 * failures));
      }
    }
  }

  return {
    runJob,
    pollOnce,
    start,
    stop: () => {
      stopped = true;
    },
    active: () => running,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const agent = createAgent({
    remoteUrl: process.env.BOXPHONE_REMOTE_URL || '',
    agentToken: process.env.BOXPHONE_AGENT_TOKEN || '',
    bridgeToken: process.env.BOXPHONE_BRIDGE_TOKEN || '',
    bridgeUrl: `http://127.0.0.1:${process.env.BOXPHONE_PORT || 8767}`,
    log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
  });
  console.log('Boxphone agent started');
  await agent.start();
}
