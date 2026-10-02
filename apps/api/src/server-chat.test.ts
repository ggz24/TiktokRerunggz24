import assert from 'node:assert/strict';
import test from 'node:test';
import type { chromium } from 'playwright-core';
import { ServerChat } from './server-chat.js';
import {
  CommentReplyService,
  defaultReplySettings,
  type CommentReplyStore,
} from './ai-comments.js';

function fixture(shopRoomOverride?: string, follow = false) {
  let room = '7691973455174208257';
  let identity = true;
  let open = true;
  let entered = '';
  let cookies: { name: string; value: string; domain: string }[] = [];
  let launchCount = 0;
  let contextsClosed = 0;
  let responseCode = 0;
  let socketListener: (socket: unknown) => void = () => {};
  let responseListener: (response: unknown) => unknown = () => {};
  const actions: string[] = [];
  const input = {
    async count() {
      return 1;
    },
    async isVisible() {
      return true;
    },
    async isEnabled() {
      return true;
    },
    async inputValue() {
      return entered;
    },
    async fill(text: string) {
      entered = text;
      actions.push('fill');
    },
    async press(key: string) {
      actions.push(key);
    },
  };
  const page = {
    isClosed: () => false,
    setDefaultTimeout() {},
    locator(selector: string) {
      return selector.startsWith('textarea')
        ? input
        : {
            getByText() {
              return {
                async count() {
                  return identity ? 1 : 0;
                },
                first() {
                  return { async waitFor() {} };
                },
              };
            },
          };
    },
    on(event: string, handler: (socket: unknown) => void) {
      if (event === 'websocket') socketListener = handler;
      if (event === 'response') responseListener = handler;
    },
    async goto(address: string) {
      assert.equal(address, 'https://shop.tiktok.com/streamer/live/product/dashboard');
      await responseListener({
        url: () => 'https://shop.tiktok.com/api/v1/streamer_desktop/live_room_info/get',
        text: async () => `{"code":0,"data":{"room_id":${shopRoomOverride ?? room}}}`,
      });
      socketListener({
        url: () =>
          `wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/?room_id=${room}`,
        on() {},
      });
    },
    async waitForResponse(match: (r: unknown) => boolean) {
      const response = {
        url: () => 'https://shop.tiktok.com/api/v1/streamer_desktop/message/chat?X-Bogus=fake',
        request: () => ({
          method: () => 'POST',
          postDataJSON: () => ({ content: '150 บาท', meta: { room_id: room } }),
        }),
        ok: () => true,
        json: async () => ({ code: responseCode, data: { punish: 1 } }),
      };
      assert.equal(match(response), true);
      return response;
    },
  };
  const context = {
    async addCookies(value: typeof cookies) {
      cookies = value;
    },
    async route() {},
    async newPage() {
      return page;
    },
    async close() {
      contextsClosed++;
    },
  };
  const launch = (async () => {
    launchCount++;
    return {
      async newContext() {
        return context;
      },
      on() {},
      async close() {},
    };
  }) as unknown as typeof chromium.launch;
  const connector = new ServerChat(
    async (owner, account) =>
      open && owner === 'owner' && account === 'account'
        ? {
            roomId: follow ? null : room,
            handle: 'testshop',
            userId: '1234567890123456789',
            cookie: 'sessionid=fake-secret; test=value',
          }
        : null,
    '/fake/chromium',
    launch,
  );
  const store: CommentReplyStore = {
    async key() {
      return null;
    },
    async saveKey() {},
    async settings() {
      return { ...defaultReplySettings, enabled: true, knowledge: 'ราคา 150 บาท' };
    },
    async save() {},
    async recent() {
      return [];
    },
    async begin() {
      return true;
    },
    async finish() {},
  };
  connector.attach(new CommentReplyService(store, async () => '150 บาท', connector));
  return {
    connector,
    actions,
    cookies: () => cookies,
    launches: () => launchCount,
    closed: () => contextsClosed,
    setIdentity: (value: boolean) => {
      identity = value;
    },
    changeRoom: () => {
      room = '7691973455174208258';
    },
    closeRoom: () => {
      open = false;
    },
    rejectResponse: () => {
      responseCode = 5;
    },
    clearInput: () => {
      entered = '';
    },
  };
}
test('server session uses isolated TikTok cookies and verifies account and room before send', async () => {
  const f = fixture();
  try {
    assert.equal(await f.connector.ready('owner', 'account'), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await f.connector.ready('owner', 'account'), true);
    assert.equal(f.launches(), 1);
    assert.equal(f.cookies()[0].domain, '.tiktok.com');
    assert.equal((await f.connector.connectionStatus('owner', 'account')).mode, 'server');
    assert.equal(await f.connector.ready('other', 'account'), false);
    await f.connector.send('owner', 'account', '7691973455174208257', '150 บาท');
    assert.deepEqual(f.actions, ['fill', 'Enter']);
    f.setIdentity(false);
    await assert.rejects(f.connector.send('owner', 'account', '7691973455174208257', '150 บาท'));
    f.setIdentity(true);
    f.changeRoom();
    await assert.rejects(f.connector.send('owner', 'account', '7691973455174208257', '150 บาท'));
  } finally {
    await f.connector.close();
  }
});
test('Shop reporting no active room cannot enable or send AUTO', async () => {
  const f = fixture('0');
  try {
    await f.connector.ready('owner', 'account');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await f.connector.ready('owner', 'account'), false);
    assert.match((await f.connector.connectionStatus('owner', 'account')).message, /TikTok Shop/);
    await assert.rejects(f.connector.send('owner', 'account', '7691973455174208257', '150 บาท'));
    assert.deepEqual(f.actions, []);
  } finally {
    await f.connector.close();
  }
});
test('rejected send is not retried and stopped LIVE closes the connection', async () => {
  const f = fixture();
  try {
    await f.connector.ready('owner', 'account');
    await new Promise((resolve) => setImmediate(resolve));
    f.rejectResponse();
    await assert.rejects(f.connector.send('owner', 'account', '7691973455174208257', '150 บาท'));
    assert.deepEqual(f.actions, ['fill', 'Enter']);
    f.closeRoom();
    assert.equal(await f.connector.ready('owner', 'account'), false);
    assert.ok(f.closed() > 0);
  } finally {
    await f.connector.close();
  }
});

test("follows the account's own LIVE when this app has not started one", async () => {
  const f = fixture(undefined, true);
  try {
    assert.equal(await f.connector.ready('owner', 'account'), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await f.connector.ready('owner', 'account'), true);
    assert.equal(await f.connector.isCurrentRoom('owner', 'account', '7691973455174208257'), true);
    assert.equal(await f.connector.isCurrentRoom('owner', 'account', '7691973455174208258'), false);
    await f.connector.send('owner', 'account', '7691973455174208257', '150 บาท');
    assert.deepEqual(f.actions, ['fill', 'Enter']);
    await assert.rejects(f.connector.send('owner', 'account', '7691973455174208258', '150 บาท'));
  } finally {
    await f.connector.close();
  }
});

test('without an active LIVE on the account, following mode cannot enable or send', async () => {
  const f = fixture('0', true);
  try {
    await f.connector.ready('owner', 'account');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await f.connector.ready('owner', 'account'), false);
    assert.match((await f.connector.connectionStatus('owner', 'account')).message, /เริ่มไลฟ์/);
    await assert.rejects(f.connector.send('owner', 'account', '7691973455174208257', '150 บาท'));
    assert.deepEqual(f.actions, []);
  } finally {
    await f.connector.close();
  }
});

test('a wrong account cannot be followed even when a room is visible', async () => {
  const f = fixture(undefined, true);
  try {
    f.setIdentity(false);
    await f.connector.ready('owner', 'account');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await f.connector.ready('owner', 'account'), false);
    await assert.rejects(f.connector.send('owner', 'account', '7691973455174208257', '150 บาท'));
    assert.deepEqual(f.actions, []);
  } finally {
    await f.connector.close();
  }
});
