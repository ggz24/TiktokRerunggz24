import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import {
  BoxphoneInputError,
  applySettingsPatch,
  createQuestions,
  defaultSettings,
  normalizePlan,
  publicSettings,
  resolveKeys,
  withKeys,
} from './boxphone-ai.js';
import {
  BoxphoneService,
  createMemoryBoxphoneStore,
  normalizePairingCode,
  openSettings,
  sealSettings,
} from './boxphone.js';
import { registerBoxphoneRoutes } from './boxphone-routes.js';
import type { LiveService } from './live-service.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (questions: string[]) =>
  json(200, {
    output: [
      { content: [{ type: 'output_text', text: JSON.stringify({ questions, reason: 'ok' }) }] },
    ],
  });
const bearer = (init: RequestInit) =>
  String((init.headers as Record<string, string>).Authorization);

test('saved settings never expose keys; blank fields keep them and backups replace as a list', () => {
  const a = applySettingsPatch(defaultSettings(), {
    openaiKey: 'sk-main',
    transcriptionKey: 'sk-trans',
    backupKeys: { openaiKey: ['sk-b1', 'sk-b2', 'sk-b1'] },
  });
  assert.deepEqual(publicSettings(a), {
    hasTranscriptionKey: true,
    hasOpenaiKey: true,
    hasOpenrouterKey: false,
    backupCounts: { transcriptionKey: 0, openaiKey: 2, openrouterKey: 0 },
    questionProvider: 'openai',
    questionModels: { openai: 'gpt-4o-mini', openrouter: 'openai/gpt-4o-mini' },
  });
  assert.equal(JSON.stringify(publicSettings(a)).includes('sk-'), false);
  const b = applySettingsPatch(a, { openaiKey: '  ', backupKeys: { openaiKey: [] } });
  assert.equal(b.openaiKey, 'sk-main');
  assert.deepEqual(b.backupKeys.openaiKey, ['sk-b1', 'sk-b2']);
  const c = applySettingsPatch(b, { backupKeys: { openaiKey: ['sk-new'] } });
  assert.deepEqual(c.backupKeys.openaiKey, ['sk-new']);
  assert.throws(() => applySettingsPatch(c, { openaiKey: 'has space' }), BoxphoneInputError);
  assert.throws(
    () => applySettingsPatch(c, { backupKeys: { openaiKey: ['ok', 'bad key'] } }),
    BoxphoneInputError,
  );
  assert.throws(
    () => applySettingsPatch(c, { questionModels: { openai: 'bad model!' } }),
    BoxphoneInputError,
  );
});

test('encrypted settings are bound to the owner', () => {
  const key = randomBytes(32);
  const settings = applySettingsPatch(defaultSettings(), {
    openaiKey: 'sk-secret',
    backupKeys: { openaiKey: ['sk-backup'] },
  });
  const sealed = sealSettings(settings, key, 'owner');
  assert.equal(sealed.includes('sk-secret'), false);
  assert.deepEqual(openSettings(sealed, key, 'owner'), settings);
  assert.throws(() => openSettings(sealed, key, 'someone-else'));
  assert.throws(() => openSettings(sealed, randomBytes(32), 'owner'));
});

test('a rejected key falls through to the next backup key; other failures do not', async () => {
  const seen: string[] = [];
  const result = await withKeys(['bad', 'good'], async (key) => {
    seen.push(key);
    if (key === 'bad') throw new BoxphoneInputError('API key ไม่ถูกต้อง', 502, true);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(seen, ['bad', 'good']);
  await assert.rejects(
    withKeys(['a', 'b'], async () => {
      throw new BoxphoneInputError('บริการล่ม', 502, false);
    }),
    /บริการล่ม/,
  );
  await assert.rejects(
    withKeys(['a', 'b', 'c'], async () => {
      throw new BoxphoneInputError('โควตาเต็ม', 502, true);
    }),
    /ลองแล้ว 3 คีย์/,
  );
  await assert.rejects(
    withKeys([], async () => 'x'),
    /กรอก API key/,
  );
});

test('service tries the saved main key then the backups, in order, for questions', async () => {
  const store = createMemoryBoxphoneStore();
  const used: string[] = [];
  const service = new BoxphoneService(store, async (_url, init) => {
    used.push(bearer(init));
    return bearer(init) === 'Bearer sk-main'
      ? json(429, { error: { code: 'insufficient_quota' } })
      : answer(['ราคาเท่าไหร่คะ']);
  });
  await service.saveSettings('owner', {
    openaiKey: 'sk-main',
    backupKeys: { openaiKey: ['sk-backup'] },
  });
  const out = await service.questions('owner', { transcript: 'ราคา 150 บาท', count: 2 });
  assert.deepEqual(used, ['Bearer sk-main', 'Bearer sk-backup']);
  assert.deepEqual(out.questions, ['ราคาเท่าไหร่คะ']);
  // another owner has no keys, so nothing is called
  await assert.rejects(service.questions('other', { transcript: 'x' }), /กรอก API key/);
  assert.deepEqual(resolveKeys(await store.loadSettings('owner'), 'openaiKey', 'sk-typed'), [
    'sk-typed',
    'sk-backup',
  ]);
});

test('transcription uses the transcription key and its backups', async () => {
  const used: string[] = [];
  const service = new BoxphoneService(createMemoryBoxphoneStore(), async (_url, init) => {
    used.push(bearer(init));
    return bearer(init) === 'Bearer t1' ? json(401, {}) : json(200, { text: 'สวัสดี' });
  });
  await service.saveSettings('owner', {
    transcriptionKey: 't1',
    backupKeys: { transcriptionKey: ['t2'] },
  });
  const result = await service.transcribe('owner', Buffer.from('audio'), 'clip.mp3', 'audio/mpeg');
  assert.equal(result.text, 'สวัสดี');
  assert.deepEqual(used, ['Bearer t1', 'Bearer t2']);
  await assert.rejects(service.transcribe('owner', Buffer.from('x'), 'clip.exe', ''), /รองรับ mp3/);
});

test('plan falls back to another model and keeps rows bounded', async () => {
  const models: string[] = [];
  const service = new BoxphoneService(createMemoryBoxphoneStore(), async (_url, init) => {
    const model = JSON.parse(String(init.body)).model as string;
    models.push(model);
    return model === 'gpt-4.1-mini'
      ? json(404, { error: { code: 'model_not_found' } })
      : json(200, {
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    questions: [
                      { at_seconds: 9999, question: 'ส่งฟรีไหมคะ' },
                      { at_seconds: 20, question: 'ราคาเท่าไหร่คะ' },
                    ],
                    reason: '',
                  }),
                },
              ],
            },
          ],
        });
  });
  await service.saveSettings('owner', { openaiKey: 'sk-1' });
  const plan = await service.plan('owner', {
    duration: 120,
    chunks: [{ start: 0, text: 'ราคา 150 บาท' }],
    planModel: 'gpt-4.1-mini',
    fallbackModel: 'gpt-4o-mini',
    minGap: 30,
  });
  assert.deepEqual(models, ['gpt-4.1-mini', 'gpt-4o-mini']);
  assert.deepEqual(
    plan.items.map((i) => i.at),
    [20, 115],
  );
  assert.equal(normalizePlan([{ at: 1, text: 'x'.repeat(130) }], { duration: 100 }).length, 0);
  await assert.rejects(service.plan('owner', { duration: 2, chunks: [] }), /ความยาว/);
});

test('openrouter questions use the openrouter key and never the openai ones', async () => {
  const urls: string[] = [];
  const out = await createQuestions(
    async (url, init) => {
      urls.push(`${url}|${bearer(init)}`);
      return json(200, {
        choices: [
          { message: { content: JSON.stringify({ questions: ['มีกี่รสคะ'], reason: '' }) } },
        ],
      });
    },
    'openrouter',
    ['or-key'],
    'vendor/model',
    { transcript: 't', style: '', previous: [], count: 3 },
  );
  assert.deepEqual(out.questions, ['มีกี่รสคะ']);
  assert.deepEqual(urls, ['https://openrouter.ai/api/v1/chat/completions|Bearer or-key']);
});

test('pairing codes work once, expire, and mint a per-computer token shown only once', async () => {
  let clock = Date.parse('2026-10-06T10:00:00Z');
  const store = createMemoryBoxphoneStore();
  const service = new BoxphoneService(store, undefined, '', () => clock);
  const { code } = await service.createPairing('owner');
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(
    await service.checkPairing(`${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`),
    true,
  ); // dash and case are forgiven
  const agent = await service.redeemPairing(code, 'โน้ตบุ๊ก\u0007ห้องไลฟ์');
  assert.equal(agent.owner, 'owner');
  assert.equal(agent.name, 'โน้ตบุ๊กห้องไลฟ์');
  assert.match(agent.token, /^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
  await assert.rejects(service.redeemPairing(code, 'again'), /หมดอายุ/);
  assert.equal(await service.checkPairing(code), false);
  assert.deepEqual(await service.authenticateAgent(agent.token), {
    id: agent.agentId,
    owner: 'owner',
    name: 'โน้ตบุ๊กห้องไลฟ์',
  });
  assert.equal(await service.authenticateAgent(`${agent.agentId}.${'0'.repeat(64)}`), null);
  assert.equal(await service.authenticateAgent('nonsense'), null);
  assert.equal((await service.listAgents('owner')).length, 1);
  assert.equal((await service.listAgents('intruder')).length, 0);
  assert.equal(await service.removeAgent('intruder', agent.agentId), false);
  assert.equal(await service.removeAgent('owner', agent.agentId), true);
  assert.equal(await service.authenticateAgent(agent.token), null);
  const late = await service.createPairing('owner');
  clock += 11 * 60 * 1000;
  await assert.rejects(service.redeemPairing(late.code, 'late'), /หมดอายุ/);
  assert.equal(normalizePairingCode('abcd-2345'), 'ABCD2345');
  assert.equal(normalizePairingCode('ABCD0OIL'), null);
});

test('guessing pairing codes is rate limited', async () => {
  const clock = Date.parse('2026-10-06T10:00:00Z');
  const service = new BoxphoneService(createMemoryBoxphoneStore(), undefined, '', () => clock);
  for (let i = 0; i < 10; i += 1)
    await assert.rejects(service.redeemPairing('ABCDEFGH', 'x'), /ไม่ถูกต้อง/);
  await assert.rejects(service.redeemPairing('ABCDEFGH', 'x'), /บ่อยเกินไป/);
});

test('routes need the owner, keep internal routes token only, and never return keys', async () => {
  const service = new BoxphoneService(createMemoryBoxphoneStore());
  const app = Fastify();
  registerBoxphoneRoutes(
    app,
    service,
    {} as LiveService,
    (headers) =>
      headers['x-internal-token'] === 'internal' && typeof headers['x-livehub-owner'] === 'string'
        ? String(headers['x-livehub-owner'])
        : null,
    (headers) => headers['x-internal-token'] === 'internal',
  );
  const owner = { 'x-internal-token': 'internal', 'x-livehub-owner': 'owner' };
  const internal = { 'x-internal-token': 'internal' };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/boxphone/ai-settings',
        payload: { operation: 'load' },
      })
    ).statusCode,
    401,
  );
  const saved = await app.inject({
    method: 'POST',
    url: '/api/v1/boxphone/ai-settings',
    headers: owner,
    payload: { operation: 'save', openaiKey: 'sk-secret', backupKeys: { openaiKey: ['sk-b'] } },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.includes('sk-'), false);
  assert.equal(JSON.parse(saved.body).backupCounts.openaiKey, 1);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/boxphone/ai-settings',
        headers: owner,
        payload: { operation: 'nope' },
      })
    ).statusCode,
    400,
  );
  const cleared = await app.inject({
    method: 'POST',
    url: '/api/v1/boxphone/ai-settings',
    headers: owner,
    payload: { operation: 'delete' },
  });
  assert.equal(JSON.parse(cleared.body).hasOpenaiKey, false);

  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/boxphone/pairings/redeem',
        payload: { code: 'ABCDEFGH' },
      })
    ).statusCode,
    401,
  );
  const pairing = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/boxphone/pairings',
        headers: owner,
        payload: {},
      })
    ).body,
  );
  const redeemed = await app.inject({
    method: 'POST',
    url: '/api/v1/boxphone/pairings/redeem',
    headers: internal,
    payload: { code: pairing.code, name: 'PC1' },
  });
  assert.equal(redeemed.statusCode, 200);
  const agent = JSON.parse(redeemed.body);
  const auth = await app.inject({
    method: 'POST',
    url: '/api/v1/boxphone/agents/authenticate',
    headers: internal,
    payload: { token: agent.token },
  });
  assert.equal(JSON.parse(auth.body).owner, 'owner');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/boxphone/agents/authenticate',
        headers: internal,
        payload: { token: 'bad' },
      })
    ).statusCode,
    401,
  );
  const list = JSON.parse(
    (await app.inject({ method: 'GET', url: '/api/v1/boxphone/agents', headers: owner })).body,
  );
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].name, 'PC1');
  assert.equal(JSON.stringify(list).includes(agent.token), false);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/boxphone/agents/${agent.agentId}`,
        headers: { ...owner, 'x-livehub-owner': 'other' },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/boxphone/agents/${agent.agentId}`,
        headers: owner,
      })
    ).statusCode,
    200,
  );
  await app.close();
});
