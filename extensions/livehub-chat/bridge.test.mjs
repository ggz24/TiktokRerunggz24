import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('content script cannot retrieve bearer token; background forwards only to localhost', async () => {
  let listener;
  const calls = [];
  const pairing = {
    token: 'a'.repeat(64),
    roomId: '7690000000000000001',
    handle: 'testshop',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const context = {
    chrome: {
      runtime: {
        id: 'extension',
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
      storage: {
        session: {
          async get() {
            return { pairing };
          },
          async set() {},
          async remove() {},
        },
      },
    },
    Date,
    String,
    AbortSignal,
    async fetch(url, init) {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return { job: null };
        },
      };
    },
  };
  vm.runInNewContext(await readFile(new URL('./background.js', import.meta.url), 'utf8'), context);
  const sender = {
    id: 'extension',
    url: 'https://shop.tiktok.com/streamer/live/product/dashboard?region=us',
  };
  const configuration = await new Promise((resolve) =>
    listener({ type: 'config' }, sender, resolve),
  );
  assert.equal(configuration.pairing.token, undefined);
  assert.equal(configuration.pairing.roomId, pairing.roomId);
  assert.equal(calls.length, 0);
  await new Promise((resolve) =>
    listener({ type: 'relay', body: { action: 'poll' } }, sender, resolve),
  );
  assert.equal(calls[0].url, 'http://localhost:3100/api/chat-bridge');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ' + pairing.token);
  assert.equal(
    listener({ type: 'relay' }, { id: 'other', url: sender.url }, () => {}),
    false,
  );
});

test('page wrappers preserve unrelated requests and responses', async () => {
  const calls = [];
  class Xhr {
    open(...args) {
      calls.push(['open', ...args]);
    }
    send(body) {
      calls.push(['send', body]);
    }
  }
  const response = { ok: true };
  const window = {
    WebSocket: class {},
    async fetch(...args) {
      calls.push(['fetch', ...args]);
      return response;
    },
    addEventListener() {},
    postMessage() {},
  };
  vm.runInNewContext(await readFile(new URL('./page.js', import.meta.url), 'utf8'), {
    window,
    XMLHttpRequest: Xhr,
    URL,
    WeakMap,
    Set,
    location: { origin: 'https://shop.tiktok.com', href: 'https://shop.tiktok.com/' },
  });
  const xhr = new Xhr();
  xhr.open('POST', '/other', true);
  xhr.send('unchanged-body');
  const init = { method: 'GET' };
  assert.equal(await window.fetch('/other', init), response);
  assert.deepEqual(calls[1], ['send', 'unchanged-body']);
  assert.equal(calls[2][2], init);
});
