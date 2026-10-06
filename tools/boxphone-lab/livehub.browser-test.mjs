// Developer smoke test: fresh headless browser, synthetic phones/channels, no external AI/ADB calls.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BOXPHONE_TEST_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(
  process.env.BOXPHONE_TEST_CHROMIUM
    ? { executablePath: process.env.BOXPHONE_TEST_CHROMIUM, args: ['--no-sandbox'], headless: true }
    : { channel: 'chrome', headless: true },
);
const page = await browser.newPage({ viewport: { width: 1400, height: 1050 } });
const errors = [],
  calls = [],
  jobs = [];
let late = false,
  finish;
let savedCredentials = {
  hasTranscriptionKey: false,
  hasOpenaiKey: false,
  hasOpenrouterKey: false,
  questionProvider: 'openai',
  questionModels: { openai: 'gpt-4o-mini', openrouter: 'openai/gpt-4o-mini' },
};
const channels = [
  {
    id: 'a',
    alias: 'ร้าน A',
    handle: 'shop_a',
    connected: true,
    status: 'live',
    videoId: 'v1',
    videoName: 'คลิป A.mp4',
    startedAt: '2026-10-06T00:00:00Z',
    aiEnabled: true,
    aiReady: true,
    chatReady: true,
  },
  {
    id: 'b',
    alias: 'ร้าน B',
    handle: 'shop_b',
    connected: true,
    status: 'live',
    videoId: 'v2',
    videoName: 'คลิป B.mp4',
    startedAt: '2026-10-06T00:00:00Z',
    aiEnabled: true,
    aiReady: true,
    chatReady: true,
  },
];
const target = (id) => ({ accountId: id, handle: 'shop_' + id, key: 'room-' + id });
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/*', async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    action = url.pathname.split('/').pop();
  const reply = (data) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  if (url.hostname !== 'boxphone.test') return route.abort();
  if (action === 'view') {
    const html = (await readFile(new URL('index.html', import.meta.url), 'utf8'))
      .replace('__TOKEN__', 'test-token')
      .replace(
        '</head>',
        '<meta name="lab-api-root" content="/api/boxphone"><meta name="lab-livehub-root" content=""><meta name="lab-owner" content="test"><link rel="stylesheet" href="/api/boxphone/livehub.css"><link rel="stylesheet" href="/api/boxphone/theme.css"></head>',
      )
      .replace('<body>', '<body class="cyber-shell boxphone-theme">')
      .replace('src="/app.js"', 'src="/api/boxphone/app.js"');
    return route.fulfill({ contentType: 'text/html', body: html });
  }
  if (
    [
      'app.js',
      'continuous.mjs',
      'message-policy.mjs',
      'target-policy.mjs',
      'livehub.mjs',
      'credentials.mjs',
      'plan.mjs',
      'theme.css',
      'livehub.css',
    ].includes(action)
  ) {
    const path =
      action === 'livehub.css'
        ? new URL('../../apps/web/app/cyber.css', import.meta.url)
        : new URL(action, import.meta.url);
    return route.fulfill({
      contentType: action.endsWith('.css') ? 'text/css' : 'text/javascript',
      body: await readFile(path, 'utf8'),
    });
  }
  if (action === 'catalog')
    return reply({
      channels,
      videos: [
        { id: 'v1', name: 'คลิป A.mp4', status: 'ready' },
        { id: 'v2', name: 'คลิป B.mp4', status: 'ready' },
      ],
    });
  const data = request.method() === 'POST' ? request.postDataJSON() : {};
  calls.push({ action, data });
  if (action === 'ai-settings') {
    if (data.operation === 'delete')
      savedCredentials = {
        ...savedCredentials,
        hasTranscriptionKey: false,
        hasOpenaiKey: false,
        hasOpenrouterKey: false,
      };
    if (data.operation === 'save') {
      for (const [field, flag] of [
        ['transcriptionKey', 'hasTranscriptionKey'],
        ['openaiKey', 'hasOpenaiKey'],
        ['openrouterKey', 'hasOpenrouterKey'],
      ])
        if (data[field]) savedCredentials[flag] = true;
      if (data.questionProvider) savedCredentials.questionProvider = data.questionProvider;
      Object.assign(savedCredentials.questionModels, data.questionModels);
    }
    return reply(savedCredentials);
  }
  if (action === 'devices')
    return reply({
      devices: [
        {
          serial: 'phone-1',
          state: 'device',
          model: 'Android A',
          xiaoweiNumber: 42,
          xiaoweiName: 'SM-G950F',
        },
        {
          serial: 'phone-2',
          state: 'device',
          model: 'Android B',
          xiaoweiNumber: 57,
          xiaoweiName: '112',
        },
      ],
    });
  if (action === 'screenshot')
    return reply({
      image:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    });
  if (action === 'detect-chat' || action === 'prepare-chat')
    return reply({
      serial: data.serial,
      width: 1440,
      height: 2960,
      stable: true,
      source: 'verified-ui',
      checkedAt: new Date().toISOString(),
      detail: 'ตรวจพบช่องพิมพ์ ไม่พิมพ์และไม่กดส่ง',
      chat: {
        x: 600,
        y: 2670,
        focused: action === 'prepare-chat',
        bounds: { x1: 100, y1: 2630, x2: 1200, y2: 2700 },
      },
      send: null,
      image:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    });
  if (action === 'transcribe-video')
    return reply({
      text: 'บทพูดจากคลัง',
      videoName: 'คลิป A.mp4',
      startSeconds: data.startSeconds ?? 15,
      durationSeconds: 125,
    });
  if (action === 'plan-questions')
    return reply({ items: [{ at: 0, text: 'โปรนี้ส่งฟรีไหมครับ' }], model: 'gpt-4.1-mini' });
  if (action === 'channel-transcript')
    return reply({
      text: 'บทพูดของช่อง ' + data.accountId,
      target: target(data.accountId),
      startSeconds: 100,
    });
  if (action === 'questions') {
    if (late)
      await new Promise((resolve) => {
        finish = resolve;
      });
    return reply({
      questions: [
        data.transcript.endsWith('a') ? 'สินค้ามีสีอะไรให้เลือกบ้าง' : 'ขอรายละเอียดการจัดส่งครับ',
      ],
    });
  }
  if (action === 'open-live')
    return reply({ verified: true, target: target(data.targetAccountId) });
  if (action === 'detect-chat')
    return reply({ chat: { x: 100, y: 850 }, send: { x: 800, y: 850 } });
  if (action === 'send') {
    jobs.push(data);
    return reply({ delivery: 'observed_local', attempted: true, detail: 'ส่งทดสอบสำเร็จ' });
  }
  return route.fulfill({ status: 404, body: '{}' });
});
try {
  await page.goto('http://boxphone.test/api/boxphone/view');
  await page.waitForFunction(() => document.querySelector('#count').textContent === '2');
  assert.equal(
    calls.filter((c) => c.action === 'ai-settings' && c.data.operation === 'save').length,
    0,
  );
  await page.fill('#deviceSearch', '57');
  assert.equal(await page.locator('#devices .device').count(), 1);
  await page.getByRole('button', { name: 'หาเครื่อง #57', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#screen').hasAttribute('src'));
  assert.equal(calls.find((c) => c.action === 'screenshot').data.serial, 'phone-2');
  assert.match(await page.locator('#screenTitle').innerText(), /#57/);
  await page.fill('#deviceNickname', 'โทรศัพท์ข้างโต๊ะ');
  await page.click('#saveDeviceNickname');
  await page.click('#closeScreen');
  await page.fill('#deviceSearch', 'โทรศัพท์ข้างโต๊ะ');
  assert.equal(await page.locator('#devices .device').count(), 1);
  assert.match(await page.locator('#devices').innerText(), /#57/);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#count').textContent === '2');
  assert.match(await page.locator('#devices').innerText(), /โทรศัพท์ข้างโต๊ะ/);
  assert.equal(jobs.length, 0);
  await page.fill('#transcriptionKey', 'synthetic-transcription-key');
  await page.fill('#questionKey', 'synthetic-openai-key');
  await page.click('#saveAiKeys');
  await page.waitForFunction(
    () =>
      document.querySelector('#questionKey').placeholder.includes('บันทึกแล้ว') &&
      document.querySelector('#questionKey').value === '',
  );
  await page.selectOption('#questionProvider', 'openrouter');
  await page.fill('#questionKey', 'synthetic-router-key');
  await page.fill('#questionModel', 'vendor/model');
  await page.click('#saveAiKeys');
  await page.waitForFunction(() => document.querySelector('#questionKey').value === '');
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector('#questionProvider').value === 'openrouter' &&
      !document.querySelector('#questionProvider').disabled,
  );
  assert.equal(await page.inputValue('#questionModel'), 'vendor/model');
  assert.equal(await page.inputValue('#questionKey'), '');
  assert.equal(await page.inputValue('#transcriptionKey'), '');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.ok(!storage.includes('synthetic-'));
  await page.selectOption('#questionProvider', 'openai');
  await page.waitForFunction(() =>
    document.querySelector('#questionKey').placeholder.includes('บันทึกแล้ว'),
  );
  assert.equal(await page.locator('#localSource').isVisible(), false);
  await page.selectOption('#libraryVideo', 'v1');
  await page.fill('#libraryStart', '15');
  await page.click('#libraryTranscribe');
  await page.waitForFunction(() => document.querySelector('#transcript').value === 'บทพูดจากคลัง');
  assert.equal(calls.find((c) => c.action === 'transcribe-video').data.videoId, 'v1');
  await page.locator('#devices input[type=checkbox]').nth(0).check();
  await page.locator('#detectChat').scrollIntoViewIfNeeded();
  await page.locator('#detectChat').click();
  await page.waitForFunction(() =>
    document.querySelector('#detectResult').innerText.includes('ตรงกันสองครั้ง'),
  );
  assert.equal(await page.locator('#sendX').inputValue(), '');
  await page.locator('#prepareChat').click();
  await page.locator('#composerDialog[open]').waitFor();
  assert.match(await page.locator('#composerTitle').innerText(), /#42/);
  assert.equal(calls.find((c) => c.action === 'prepare-chat').data.serial, 'phone-1');
  assert.equal(calls.filter((c) => c.action === 'send').length, 0);
  await page.locator('#closeComposerDialog').click();
  await page.locator('#devices input[type=checkbox]').nth(1).check();
  await page.locator('#detectChat').click();
  await page.waitForFunction(() =>
    document.querySelector('#status').innerText.includes('เพียงหนึ่งเครื่อง'),
  );
  assert.equal(calls.filter((c) => c.action === 'detect-chat').length, 1);
  await page.locator('#deviceTargets select').nth(0).selectOption('a');
  await page.locator('#deviceTargets select').nth(1).selectOption('b');
  assert.equal(await page.locator('#modeSwitch').count(), 0);
  assert.equal(await page.locator('#confirmLiveDialog').count(), 0);
  assert.equal(jobs.length, 0); // Page load does not start real sends.
  assert.equal(await page.locator('#planUse').isChecked(), true); // plan mode is the default
  await page.uncheck('#planUse'); // this part covers the per-round live transcript mode
  await page.click('#startChannelAuto');
  await page.waitForFunction(() => document.querySelectorAll('#queue tr').length === 2);
  await page.waitForFunction(() =>
    document.querySelector('#queue').innerText.includes('ส่งทดสอบสำเร็จ'),
  );
  await page.click('#stopChannelAuto');
  assert.deepEqual(
    calls
      .filter((c) => c.action === 'open-live')
      .map((c) => [c.data.serial, c.data.targetAccountId]),
    [
      ['phone-1', 'a'],
      ['phone-2', 'b'],
    ],
  );
  assert.equal(jobs[0].serial, 'phone-1');
  assert.equal(jobs[0].targetAccountId, 'a');
  assert.equal(jobs[0].targetKey, 'room-a');
  await page.locator('#deviceTargets select').nth(1).selectOption('a');
  assert.match(await page.locator('#queue').innerText(), /ยกเลิก: เปลี่ยนช่องปลายทาง/);
  await page.click('#clearQueue');
  late = true;
  await page.click('#startChannelAuto');
  await page.waitForFunction(() =>
    document.querySelector('#channelAutoInfo').innerText.includes('อ่านบทพูด'),
  );
  for (let n = 0; n < 50 && !finish; n++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(finish);
  await page.click('#stopChannelAuto');
  finish();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await page.locator('#queue tr').count(), 0);
  assert.equal(calls.find((c) => c.action === 'transcribe-video').data.transcriptionKey, '');
  assert.equal(calls.find((c) => c.action === 'questions').data.questionKey, '');
  // Plan mode: a missing plan is built from the whole clip, then questions are asked with no per-round AI calls.
  late = false;
  await page.click('#clearQueue');
  await page.check('#planUse');
  const before = {
    questions: calls.filter((c) => c.action === 'questions').length,
    live: calls.filter((c) => c.action === 'channel-transcript').length,
    heard: calls.filter((c) => c.action === 'transcribe-video').length,
    sent: jobs.length,
  };
  await page.click('#startChannelAuto');
  await page.waitForFunction(() => document.querySelectorAll('#queue tr').length === 1);
  await page.waitForFunction(() =>
    document.querySelector('#queue').innerText.includes('โปรนี้ส่งฟรีไหมครับ'),
  );
  await page.waitForFunction(() =>
    document.querySelector('#queue').innerText.includes('ส่งทดสอบสำเร็จ'),
  );
  await page.click('#stopChannelAuto');
  assert.equal(calls.filter((c) => c.action === 'transcribe-video').length - before.heard, 3); // 0:00, 1:00 and 2:00 windows
  const planCall = calls.filter((c) => c.action === 'plan-questions');
  assert.equal(planCall.length, 1);
  assert.equal(planCall[0].data.chunks.length, 3);
  assert.equal(planCall[0].data.duration, 125);
  assert.equal(calls.filter((c) => c.action === 'questions').length, before.questions);
  assert.equal(calls.filter((c) => c.action === 'channel-transcript').length, before.live);
  assert.equal(jobs.length - before.sent, 1);
  assert.equal(jobs.at(-1).text, 'โปรนี้ส่งฟรีไหมครับ');
  assert.match(await page.locator('#deviceTargets').innerText(), /แผนคำถามของคลิปนี้: พร้อม 1 ข้อ/);
  await page.click('#forgetKey');
  await page.waitForFunction(() =>
    document.querySelector('#keySaveStatus').innerText.includes('ยังไม่บันทึก'),
  );
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#questionProvider').disabled);
  assert.ok(!(await page.getAttribute('#questionKey', 'placeholder')).includes('บันทึกแล้ว'));
  await mkdir(new URL('../../work/', import.meta.url), { recursive: true });
  await page.screenshot({
    path: new URL('../../work/boxphone-routing.png', import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      '$1',
    ),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Xiaowei numbers, search, correct screenshot, persistent names, library selection, routing, real-only UI, cancellation',
  );
} finally {
  await browser.close();
}
