import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installContinuous } from './continuous.mjs';

function fixture(api, overrides = {}) {
  const elements = new Map();
  function node() {
    return {
      value: '',
      textContent: '',
      children: [],
      style: {},
      append(...x) {
        this.children.push(...x);
      },
      replaceChildren(...x) {
        this.children = x;
      },
      after() {},
      closest() {
        return this;
      },
      setAttribute() {},
      addEventListener() {},
      set innerHTML(v) {
        for (const m of v.matchAll(/id="([^"]+)"/g)) elements.set(m[1], node());
      },
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  globalThis.document = { getElementById: get, createElement: node };
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = {
    getItem() {
      return null;
    },
    setItem() {},
  };
  let transcript = 'กำลังอธิบายวิธีทำขนมและส่วนผสม';
  const jobs = [];
  let starts = 0,
    pauses = 0;
  const lab = installContinuous({
    serials: () => ['a', 'b'],
    label: (s) => s,
    startQueue() {
      starts++;
    },
    transcriptionKey: () => 'fake-transcription-key',
    questionConfig: () => ({ provider: 'openai', key: 'fake-question-key', model: 'gpt-4o-mini' }),
    transcript: () => transcript,
    setTranscript: (t) => {
      transcript = t;
    },
    style: () => '',
    previous: () => [],
    pendingSerials: () => [],
    api,
    enqueue: (...x) => jobs.push(x),
    status() {},
    pause() {
      pauses++;
    },
    live: () => false,
    ...overrides,
  });
  return {
    lab,
    jobs,
    get,
    starts: () => starts,
    pauses: () => pauses,
    setTranscript: (t) => {
      transcript = t;
    },
    draftValues: () => get('drafts').children.map((row) => row.children[1].value),
  };
}
test('AI assigns distinct results to distinct devices', async () => {
  const f = fixture(async () => ({
    questions: ['ขอรายละเอียดส่วนผสมครับ', 'ใช้เวลาอบเท่าไรครับ'],
    reason: 'ตัวอย่าง',
  }));
  await f.lab.generate();
  assert.deepEqual(f.draftValues(), ['ขอรายละเอียดส่วนผสมครับ', 'ใช้เวลาอบเท่าไรครับ']);
  await f.get('queueDistinct').onclick();
  assert.deepEqual(
    f.jobs.map((x) => x.slice(0, 2)),
    [
      ['a', 'ขอรายละเอียดส่วนผสมครับ'],
      ['b', 'ใช้เวลาอบเท่าไรครับ'],
    ],
  );
  f.lab.stop();
});
test('stop discards a late AI result', async () => {
  let finish;
  const f = fixture(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = f.lab.generate();
  f.lab.stop();
  finish({ questions: ['ใช้เวลาอบเท่าไรครับ'] });
  await pending;
  assert.deepEqual(f.draftValues(), []);
  assert.equal(f.jobs.length, 0);
});
test('changed transcript discards a stale result', async () => {
  let finish;
  const f = fixture(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = f.lab.generate();
  f.setTranscript('เปลี่ยนไปพูดเรื่องเครื่องครัว');
  finish({ questions: ['ใช้เวลาอบเท่าไรครับ'] });
  await pending;
  assert.deepEqual(f.draftValues(), []);
  f.lab.stop();
});
test('identical AI variants are not distributed to a second phone', async () => {
  const f = fixture(async () => ({ questions: ['ราคาเท่าไรครับ', 'ราคาเท่าไรคะ'] }));
  await f.lab.generate();
  assert.deepEqual(f.draftValues(), ['ราคาเท่าไรครับ', '']);
  f.lab.stop();
});
test('automatic rounds reuse full transcript, include history and enqueue new questions', async () => {
  const requests = [];
  const f = fixture(async (path, data) => {
    requests.push(data);
    return {
      questions: requests.length === 1 ? ['ใช้เวลาอบเท่าไรครับ'] : ['เก็บขนมได้นานกี่วันครับ'],
    };
  });
  f.setTranscript('ส่วนผสมมีแป้งและกะทิ\nกำลังอบขนม');
  await f.lab.generate({ automatic: true });
  await f.lab.generate({ automatic: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].transcript, 'ส่วนผสมมีแป้งและกะทิ\nกำลังอบขนม');
  assert.ok(requests[1].previous.includes('ใช้เวลาอบเท่าไรครับ'));
  assert.deepEqual(
    f.jobs.map((x) => x[1]),
    ['ใช้เวลาอบเท่าไรครับ', 'เก็บขนมได้นานกี่วันครับ'],
  );
  f.lab.stop();
});
test('duplicate-only automatic result backs off until transcript changes', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { questions: ['ราคาเท่าไรครับ'] };
  });
  await f.lab.generate({ automatic: true });
  await f.lab.generate({ automatic: true });
  await f.lab.generate({ automatic: true });
  assert.equal(calls, 2);
  assert.equal(f.jobs.length, 1);
  f.setTranscript('กำลังพูดเรื่องการจัดส่ง');
  await f.lab.generate({ automatic: true });
  assert.equal(calls, 3);
  f.lab.stop();
});
test('single start starts queue and stop rejects late automatic enqueue', async () => {
  let finish;
  const f = fixture(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  await f.get('startQuestions').onclick();
  assert.equal(f.starts(), 1);
  assert.equal(f.lab.active(), true);
  f.lab.stop();
  finish({ questions: ['ใช้เวลาอบเท่าไรครับ'] });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.lab.active(), false);
  assert.equal(f.jobs.length, 0);
  assert.ok(f.pauses() > 0);
});
test('queue startup failure does not leave automatic mode stuck', async () => {
  const f = fixture(async () => ({ questions: [] }), {
    startQueue() {
      throw new Error('queue unavailable');
    },
  });
  await f.get('startQuestions').onclick();
  assert.equal(f.lab.active(), false);
  assert.equal(f.get('startQuestions').disabled, false);
  f.lab.stop();
});
test('a completed audio segment generates and enqueues questions immediately', async (t) => {
  const saved = new Map();
  function global(name, value) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let meter;
  const recorders = [];
  const calls = [];
  const track = { stop() {} };
  const capture = { getAudioTracks: () => [track], getTracks: () => [track] };
  global('navigator', { mediaDevices: { getUserMedia: async () => capture } });
  global(
    'MediaStream',
    class {
      constructor(tracks) {
        this.tracks = tracks;
      }
      getAudioTracks() {
        return this.tracks;
      }
    },
  );
  global(
    'AudioContext',
    class {
      async resume() {}
      close() {}
      createAnalyser() {
        return {
          getFloatTimeDomainData(a) {
            a.fill(0.02);
          },
        };
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
    },
  );
  global(
    'FileReader',
    class {
      readAsDataURL() {
        this.result = 'data:audio/webm;base64,YQ==';
        this.onload();
      }
    },
  );
  global(
    'MediaRecorder',
    class {
      constructor() {
        recorders.push(this);
        this.state = 'inactive';
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        return this.onstop();
      }
    },
  );
  t.mock.method(globalThis, 'setInterval', (fn) => {
    meter = fn;
    return 987654;
  });
  const f = fixture(async (path) => {
    calls.push(path);
    return path === 'transcribe'
      ? { text: 'กำลังทำขนมด้วยแป้งข้าวเจ้า' }
      : { questions: ['ต้องใช้แป้งเท่าไรครับ'] };
  });
  try {
    await f.get('listenMic').onclick();
    meter();
    recorders[0].ondataavailable({ data: new Blob(['audio']) });
    await recorders[0].stop();
    assert.deepEqual(calls, ['transcribe', 'questions']);
    assert.equal(f.jobs.length, 1);
    assert.equal(f.jobs[0][1], 'ต้องใช้แป้งเท่าไรครับ');
  } finally {
    f.lab.stop();
    for (const [name, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  }
});
