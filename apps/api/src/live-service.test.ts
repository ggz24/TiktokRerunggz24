import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { encryptAccountCookie, type AccountStore } from './accounts.js';
import { createApp } from './app.js';
import {
  LiveError,
  LiveService,
  type AutoRoomCreator,
  type LiveDestinationProvider,
} from './live-service.js';
import type { LiveConfigRow, LiveStore, LiveVideo } from './live-store.js';

const owner = 'test-owner';
const accountId = '00000000-0000-4000-8000-000000000001';
const secret = 'synthetic-private-stream-key';
const token = 'synthetic-internal-token-1234567890123456';
const headers = { 'x-internal-token': token, 'x-livehub-owner': owner };
const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  stdio: (PassThrough | null)[] = [null, null, new PassThrough(), new PassThrough()];
  get stderr(): PassThrough | null {
    return this.stdio[2];
  }
  kill(): boolean {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    this.emit('exit', 0, 'SIGTERM');
    return true;
  }
  fail(): void {
    this.exitCode = 1;
    this.emit('exit', 1, null);
  }
  progress(): void {
    this.stdio[3]?.write('frame=30\nprogress=continue\n');
  }
}

function fixture(
  mediaDir: string,
  canProbe = true,
  destinationProvider?: LiveDestinationProvider,
  autoRoomCreator?: AutoRoomCreator,
) {
  const videos = new Map<string, LiveVideo>();
  const configs = new Map<string, LiveConfigRow>();
  const children: FakeChild[] = [];
  const args: string[][] = [];
  let accountStatus: string | null = 'connected';
  const store: LiveStore = {
    accountStatus: async (who, id) => (who === owner && id === accountId ? accountStatus : null),
    listVideos: async (who) => (who === owner ? [...videos.values()] : []),
    findVideo: async (who, id) => (who === owner ? (videos.get(id) ?? null) : null),
    insertVideo: async (who, video) => {
      assert.equal(who, owner);
      videos.set(video.id, video);
    },
    deleteVideo: async (who, id) => {
      if (who !== owner || !videos.has(id)) return 'missing';
      if ([...configs.values()].some((config) => config.videoId === id)) return 'in_use';
      videos.delete(id);
      return 'deleted';
    },
    videoUsage: async (who) => ({
      count: who === owner ? videos.size : 0,
      bytes:
        who === owner ? [...videos.values()].reduce((sum, video) => sum + video.sizeBytes, 0) : 0,
    }),
    listConfiguredAccountIds: async (who) => (who === owner ? [...configs.keys()] : []),
    getConfig: async (who, id) => (who === owner ? (configs.get(id) ?? null) : null),
    saveConfig: async (who, id, config) => {
      assert.equal(who, owner);
      configs.set(id, config);
    },
  };
  const accountStore = {
    list: async (who: string) =>
      who === owner
        ? [
            {
              id: accountId,
              alias: 'Test account',
              liveTitle: '',
              verificationStatus: accountStatus,
              probe: 'not_run',
              probeHttpStatus: null,
              createdAt: new Date().toISOString(),
            },
          ]
        : [],
    delete: async () => true,
    findEncrypted: async (who: string, id: string) =>
      who === owner && id === accountId
        ? {
            id,
            ownerId: who,
            ...encryptAccountCookie('sessionid=synthetic-cookie', Buffer.alloc(32, 17), who, id),
          }
        : null,
  } as unknown as AccountStore;
  const service = new LiveService(
    store,
    accountStore,
    Buffer.alloc(32, 17),
    mediaDir,
    (_command: string, argv: string[], options: SpawnOptions) => {
      assert.equal(options.shell, false);
      args.push(argv);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    async () => canProbe,
    destinationProvider,
    autoRoomCreator,
  );
  return {
    service,
    store,
    accountStore,
    configs,
    children,
    args,
    setAccountStatus(value: string | null) {
      accountStatus = value;
    },
  };
}

async function withFixture(
  run: (value: ReturnType<typeof fixture>) => Promise<void>,
  canProbe = true,
  destinationProvider?: LiveDestinationProvider,
  autoRoomCreator?: AutoRoomCreator,
) {
  const mediaDir = await fs.mkdtemp(join(tmpdir(), 'live-service-test-'));
  try {
    await run(fixture(mediaDir, canProbe, destinationProvider, autoRoomCreator));
  } finally {
    await fs.rm(mediaDir, { recursive: true, force: true });
  }
}

test('video upload validates MP4 and owner metadata without accepting paths', async () => {
  await withFixture(async ({ service }) => {
    const item = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
    assert.equal(item.name, 'clip.mp4');
    assert.equal(item.sizeBytes, mp4.length);
    assert.deepEqual(await service.listVideos(owner), [item]);
    assert.deepEqual(await service.listVideos('other-owner'), []);
    await assert.rejects(
      service.uploadVideo(owner, '../escape.mp4', Readable.from(mp4)),
      (error: unknown) => error instanceof LiveError && error.statusCode === 400,
    );
    await assert.rejects(
      service.uploadVideo(owner, 'bad.mp4', Readable.from(Buffer.from('not an MP4 file'))),
      (error: unknown) => error instanceof LiveError && error.statusCode === 400,
    );
  });
});

test('RTMP secrets stay encrypted; live requires progress and tracks actual process exit', async () => {
  await withFixture(async ({ service, configs, children, args }) => {
    const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
    const configured = await service.configure(owner, accountId, {
      rtmpUrl: 'rtmps://example.invalid/live',
      streamKey: secret,
      videoId: video.id,
    });
    assert.equal(configured.hasRtmpConfig, true);
    assert.equal(JSON.stringify(configured).includes(secret), false);
    assert.equal(configs.get(accountId)?.streamKey.ciphertext.includes(Buffer.from(secret)), false);
    const starting = await service.start(owner, accountId);
    assert.equal(starting.status, 'starting');
    assert.equal(service.isActive(owner, accountId), true);
    assert.equal(children.length, 1);
    assert.equal(args[0].at(-1), `rtmps://example.invalid/live/${secret}`);
    assert.equal(JSON.stringify(starting).includes(secret), false);
    children[0].progress();
    const live = await service.session(owner, accountId);
    assert.equal(live.status, 'live');
    assert.ok(live.startedAt);
    assert.equal(JSON.stringify(live).includes(secret), false);
    children[0].stdio[2]?.write(
      `rtmps://example.invalid/live/${secret}: Operation not permitted\n`,
    );
    children[0].fail();
    const failed = await service.session(owner, accountId);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /rejected the connection/);
    assert.equal(service.isActive(owner, accountId), false);
    assert.equal(JSON.stringify(failed).includes(secret), false);
  });
});

test('changing the selected video keeps saved RTMP secrets and rejects active or foreign changes', async () => {
  await withFixture(async ({ service, configs, children, setAccountStatus }) => {
    const first = await service.uploadVideo(owner, 'first.mp4', Readable.from(mp4));
    const second = await service.uploadVideo(owner, 'second.mp4', Readable.from(mp4));
    await assert.rejects(
      service.selectVideo(owner, accountId, first.id),
      (error: unknown) => error instanceof LiveError && error.statusCode === 422,
    );
    await service.configure(owner, accountId, {
      rtmpUrl: 'rtmps://example.invalid/live',
      streamKey: secret,
      videoId: first.id,
    });
    const before = configs.get(accountId);
    assert.ok(before);
    const changed = await service.selectVideo(owner, accountId, second.id);
    assert.equal(changed.videoId, second.id);
    assert.equal(changed.videoName, 'second.mp4');
    assert.equal(changed.hasRtmpConfig, true);
    assert.equal(JSON.stringify(changed).includes(secret), false);
    assert.deepEqual(configs.get(accountId)?.rtmpUrl, before.rtmpUrl);
    assert.deepEqual(configs.get(accountId)?.streamKey, before.streamKey);
    await assert.rejects(
      service.selectVideo('other-owner', accountId, first.id),
      (error: unknown) => error instanceof LiveError && error.statusCode === 404,
    );
    await assert.rejects(
      service.selectVideo(owner, accountId, '00000000-0000-4000-8000-000000000099'),
      (error: unknown) => error instanceof LiveError && error.statusCode === 404,
    );
    await assert.rejects(
      service.selectVideo(owner, accountId, 'not-a-uuid'),
      (error: unknown) => error instanceof LiveError && error.statusCode === 400,
    );
    setAccountStatus('disconnected');
    await assert.rejects(
      service.selectVideo(owner, accountId, first.id),
      (error: unknown) => error instanceof LiveError && error.statusCode === 422,
    );
    setAccountStatus('connected');
    await service.start(owner, accountId);
    children[0].progress();
    await assert.rejects(
      service.selectVideo(owner, accountId, first.id),
      (error: unknown) => error instanceof LiveError && error.statusCode === 409,
    );
    assert.equal(configs.get(accountId)?.videoId, second.id);
  });
});

test('destination provider is resolved before FFmpeg starts without claiming a platform room', async () => {
  const calls: { ownerId: string; accountId: string }[] = [];
  const destinationProvider: LiveDestinationProvider = {
    async resolve({ ownerId, accountId }) {
      calls.push({ ownerId, accountId });
      return { url: 'rtmps://example.invalid/live/provider-key' };
    },
  };
  await withFixture(
    async ({ service, children, args }) => {
      const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
      await service.configure(owner, accountId, {
        rtmpUrl: 'rtmps://example.invalid/manual',
        streamKey: secret,
        videoId: video.id,
      });
      const starting = await service.start(owner, accountId);
      assert.deepEqual(calls, [{ ownerId: owner, accountId }]);
      assert.equal(args[0].at(-1), 'rtmps://example.invalid/live/provider-key');
      assert.equal(starting.status, 'starting');
      assert.equal(JSON.stringify(starting).includes('provider-key'), false);
      assert.equal('roomId' in starting, false);
      children[0].progress();
      assert.equal((await service.session(owner, accountId)).status, 'live');
    },
    true,
    destinationProvider,
  );
});

test('unavailable destination does not launch FFmpeg or report a live stream', async () => {
  await withFixture(
    async ({ service, children }) => {
      const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
      await service.configure(owner, accountId, {
        rtmpUrl: 'rtmps://example.invalid/live',
        streamKey: secret,
        videoId: video.id,
      });
      await assert.rejects(
        service.start(owner, accountId),
        (error: unknown) => error instanceof LiveError && error.statusCode === 503,
      );
      assert.equal(children.length, 0);
      const session = await service.session(owner, accountId);
      assert.equal(session.status, 'failed');
      assert.equal(JSON.stringify(session).includes(secret), false);
    },
    true,
    { resolve: async () => Promise.reject(new LiveError(503, 'Destination unavailable.')) },
  );
});

test('stop terminates FFmpeg and a disconnected account cannot start', async () => {
  await withFixture(async ({ service, children, setAccountStatus }) => {
    const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
    await service.configure(owner, accountId, {
      rtmpUrl: 'rtmp://example.invalid/live',
      streamKey: secret,
      videoId: video.id,
    });
    await service.start(owner, accountId);
    children[0].progress();
    assert.equal((await service.stop(owner, accountId)).status, 'idle');
    assert.equal(service.isActive(owner, accountId), false);
    setAccountStatus('disconnected');
    await assert.rejects(
      service.start(owner, accountId),
      (error: unknown) => error instanceof LiveError && error.statusCode === 422,
    );
    assert.equal(children.length, 1);
  });
});

test('invalid tracks prevent FFmpeg launch and live API never returns secrets', async () => {
  await withFixture(async ({ service, accountStore, children }) => {
    const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
    await service.configure(owner, accountId, {
      rtmpUrl: 'rtmps://example.invalid/live',
      streamKey: secret,
      videoId: video.id,
    });
    await assert.rejects(
      service.start(owner, accountId),
      (error: unknown) => error instanceof LiveError && error.statusCode === 422,
    );
    assert.equal(children.length, 0);
    const app = createApp(
      { postgres: async () => {}, redis: async () => {}, worker: async () => true },
      { store: accountStore, encryptionKey: Buffer.alloc(32, 17), internalToken: token },
      service,
    );
    assert.equal((await app.inject('/api/v1/live/sessions')).statusCode, 401);
    const response = await app.inject({ method: 'GET', url: '/api/v1/live/sessions', headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes(secret), false);
    await app.close();
  }, false);
});

test('binary upload and live routes enforce ownership and block deleting an active account', async () => {
  await withFixture(async ({ service, accountStore, children }) => {
    const app = createApp(
      { postgres: async () => {}, redis: async () => {}, worker: async () => true },
      { store: accountStore, encryptionKey: Buffer.alloc(32, 17), internalToken: token },
      service,
    );
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/live/videos',
      headers: { ...headers, 'content-type': 'video/mp4', 'x-file-name': 'clip.mp4' },
      payload: mp4,
    });
    assert.equal(upload.statusCode, 201);
    const videoId = upload.json().item.id as string;
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/live/videos',
          headers: { ...headers, 'x-livehub-owner': 'other-owner' },
        })
      ).json().items.length,
      0,
    );
    const config = await app.inject({
      method: 'PUT',
      url: `/api/v1/live/sessions/${accountId}/config`,
      headers,
      payload: { rtmpUrl: 'rtmps://example.invalid/live', streamKey: secret, videoId },
    });
    assert.equal(config.statusCode, 200);
    assert.equal(config.body.includes(secret), false);
    const inUse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/live/videos/${videoId}`,
      headers,
    });
    assert.equal(inUse.statusCode, 409);
    const start = await app.inject({
      method: 'POST',
      url: `/api/v1/live/sessions/${accountId}/start`,
      headers,
    });
    assert.equal(start.statusCode, 200);
    children[0].progress();
    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/accounts/${accountId}`,
      headers,
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.includes(secret), false);
    const stop = await app.inject({
      method: 'POST',
      url: `/api/v1/live/sessions/${accountId}/stop`,
      headers,
    });
    assert.equal(stop.statusCode, 200);
    assert.equal(stop.json().item.status, 'idle');
    await app.close();
  });
});

test('video selection endpoint accepts only a video ID and never exposes saved RTMP secrets', async () => {
  await withFixture(async ({ service, accountStore }) => {
    const first = await service.uploadVideo(owner, 'first.mp4', Readable.from(mp4));
    const second = await service.uploadVideo(owner, 'second.mp4', Readable.from(mp4));
    await service.configure(owner, accountId, {
      rtmpUrl: 'rtmps://example.invalid/live',
      streamKey: secret,
      videoId: first.id,
    });
    const app = createApp(
      { postgres: async () => {}, redis: async () => {}, worker: async () => true },
      { store: accountStore, encryptionKey: Buffer.alloc(32, 17), internalToken: token },
      service,
    );
    const url = `/api/v1/live/sessions/${accountId}/video`;
    assert.equal(
      (await app.inject({ method: 'PUT', url, payload: { videoId: second.id } })).statusCode,
      401,
    );
    const invalid = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { videoId: second.id, streamKey: 'unexpected-secret' },
    });
    assert.equal(invalid.statusCode, 400);
    const foreign = await app.inject({
      method: 'PUT',
      url,
      headers: { ...headers, 'x-livehub-owner': 'other-owner' },
      payload: { videoId: second.id },
    });
    assert.equal(foreign.statusCode, 404);
    const selected = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { videoId: second.id },
    });
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json().item.videoId, second.id);
    assert.equal(selected.body.includes(secret), false);
    await app.close();
  });
});

test('auto destination uses the encrypted account session and keeps the returned key server-side', async () => {
  await withFixture(
    async ({ service, accountStore, configs }) => {
      const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
      const app = createApp(
        { postgres: async () => {}, redis: async () => {}, worker: async () => true },
        { store: accountStore, encryptionKey: Buffer.alloc(32, 17), internalToken: token },
        service,
      );
      const url = `/api/v1/live/sessions/${accountId}/auto-destination`;
      const unauthorized = await app.inject({
        method: 'POST',
        url,
        payload: { videoId: video.id, title: 'Test' },
      });
      assert.equal(unauthorized.statusCode, 401);
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { videoId: video.id, title: 'Test LIVE' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().roomId, '1234567890123456789');
      assert.equal(response.json().item.videoId, video.id);
      assert.equal(response.body.includes(secret), false);
      assert.equal(response.body.includes('synthetic-cookie'), false);
      assert.ok(configs.has(accountId));
      await app.close();
    },
    true,
    undefined,
    async ({ title, cookieHeader }) => {
      assert.equal(title, 'Test LIVE');
      assert.equal(cookieHeader, 'sessionid=synthetic-cookie');
      return {
        roomId: '1234567890123456789',
        rtmpUrl: 'rtmps://example.invalid/live',
        streamKey: secret,
      };
    },
  );
});
