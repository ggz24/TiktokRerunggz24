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
  type AutoRoomEnder,
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
  canProbe: boolean | { videoCodec: string; audioCodec: string } = true,
  destinationProvider?: LiveDestinationProvider,
  autoRoomCreator?: AutoRoomCreator,
  autoRoomEnder?: AutoRoomEnder,
  accountIds = [accountId],
  maxConcurrentStreams: number | null = null,
) {
  let currentProbe = canProbe;
  let conversions = 0;
  const videos = new Map<string, LiveVideo>();
  const configs = new Map<string, LiveConfigRow>();
  const preferredVideos = new Map<string, string>();
  const children: FakeChild[] = [];
  const args: string[][] = [];
  let accountStatus: string | null = 'connected';
  const store: LiveStore = {
    accountStatus: async (who, id) =>
      who === owner && accountIds.includes(id) ? accountStatus : null,
    listVideos: async (who) => (who === owner ? [...videos.values()] : []),
    findVideo: async (who, id) => (who === owner ? (videos.get(id) ?? null) : null),
    insertVideo: async (who, video) => {
      assert.equal(who, owner);
      videos.set(video.id, video);
    },
    updateVideo: async (who, id, patch) => {
      assert.equal(who, owner);
      const current = videos.get(id);
      if (!current) return;
      videos.set(id, {
        ...current,
        status: patch.status,
        sizeBytes: patch.sizeBytes ?? current.sizeBytes,
        error: patch.error ?? undefined,
      });
    },
    listConvertingVideos: async () =>
      [...videos.values()]
        .filter((video) => video.status === 'converting')
        .map((video) => ({ ownerId: owner, video })),
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
    getPreferredVideoId: async (who, id) =>
      who === owner ? (preferredVideos.get(id) ?? null) : null,
    savePreferredVideoId: async (who, id, videoId) => {
      assert.equal(who, owner);
      preferredVideos.set(id, videoId);
    },
  };
  const accountStore = {
    list: async (who: string) =>
      who === owner
        ? accountIds.map((id) => ({
            id,
            alias: 'Test account',
            liveTitle: '',
            verificationStatus: accountStatus,
            probe: 'not_run',
            probeHttpStatus: null,
            createdAt: new Date().toISOString(),
          }))
        : [],
    delete: async () => true,
    findEncrypted: async (who: string, id: string) =>
      who === owner && accountIds.includes(id)
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
    async () => currentProbe,
    destinationProvider,
    autoRoomCreator,
    autoRoomEnder,
    undefined,
    maxConcurrentStreams,
    async (source, destination) => {
      conversions += 1;
      await fs.copyFile(source, destination);
      currentProbe = { videoCodec: 'h264', audioCodec: 'aac' };
    },
  );
  return {
    service,
    store,
    accountStore,
    configs,
    children,
    args,
    get conversions() {
      return conversions;
    },
    setProbe(value: boolean | { videoCodec: string; audioCodec: string }) {
      currentProbe = value;
    },
    setAccountStatus(value: string | null) {
      accountStatus = value;
    },
  };
}

async function withFixture(
  run: (value: ReturnType<typeof fixture>) => Promise<void>,
  canProbe: boolean | { videoCodec: string; audioCodec: string } = true,
  destinationProvider?: LiveDestinationProvider,
  autoRoomCreator?: AutoRoomCreator,
  autoRoomEnder?: AutoRoomEnder,
  accountIds = [accountId],
  maxConcurrentStreams: number | null = null,
) {
  const mediaDir = await fs.mkdtemp(join(tmpdir(), 'live-service-test-'));
  try {
    await run(
      fixture(
        mediaDir,
        canProbe,
        destinationProvider,
        autoRoomCreator,
        autoRoomEnder,
        accountIds,
        maxConcurrentStreams,
      ),
    );
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

test('HEVC uploads appear at once as converting, become ready after background conversion, and stream with copy', async () => {
  await withFixture(
    async (context) => {
      const { service, args } = context;
      const pending = await service.uploadVideo(owner, 'hevc.mp4', Readable.from(mp4));
      assert.equal(pending.status, 'converting');
      await assert.rejects(
        service.configure(owner, accountId, {
          rtmpUrl: 'rtmps://example.invalid/live',
          streamKey: secret,
          videoId: pending.id,
        }),
        (error: unknown) => error instanceof LiveError && error.statusCode === 422,
      );
      await service.idle();
      assert.equal(context.conversions, 1);
      const [video] = await service.listVideos(owner);
      assert.equal(video.id, pending.id);
      assert.equal(video.status, 'ready');
      assert.equal(video.sizeBytes, mp4.length);
      await service.configure(owner, accountId, {
        rtmpUrl: 'rtmps://example.invalid/live',
        streamKey: secret,
        videoId: video.id,
      });
      await service.start(owner, accountId);
      assert.ok(args[0].includes('copy'));
      assert.equal(args[0].includes('libx264'), false);
    },
    { videoCodec: 'hevc', audioCodec: 'aac' },
  );
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

test('twelve accounts can stream independently without an application-level limit', async () => {
  const ids = Array.from(
    { length: 12 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  await withFixture(
    async ({ service, children, args }) => {
      const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
      await Promise.all(
        ids.map((id) =>
          service.configure(owner, id, {
            rtmpUrl: 'rtmps://example.invalid/live',
            streamKey: secret,
            videoId: video.id,
          }),
        ),
      );
      const sessions = await Promise.all(ids.map((id) => service.start(owner, id)));
      assert.equal(children.length, 12);
      assert.equal(sessions.filter((session) => session.status === 'starting').length, 12);
      assert.ok(args.every((argv) => argv.includes('copy')));
      children.forEach((child) => child.progress());
      assert.equal(
        (await service.listSessions(owner)).filter((session) => session.status === 'live').length,
        12,
      );
      await service.stop(owner, ids[0]);
      assert.equal((await service.session(owner, ids[1])).status, 'live');
    },
    { videoCodec: 'h264', audioCodec: 'aac' },
    undefined,
    undefined,
    undefined,
    ids,
  );
});

test('an optional capacity setting rejects excess streams before FFmpeg launches', async () => {
  const ids = [accountId, '00000000-0000-4000-8000-000000000002'];
  await withFixture(
    async ({ service, children }) => {
      const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
      await Promise.all(
        ids.map((id) =>
          service.configure(owner, id, {
            rtmpUrl: 'rtmps://example.invalid/live',
            streamKey: secret,
            videoId: video.id,
          }),
        ),
      );
      await service.start(owner, ids[0]);
      await assert.rejects(
        service.start(owner, ids[1]),
        (error: unknown) => error instanceof LiveError && error.statusCode === 429,
      );
      assert.equal(children.length, 1);
    },
    true,
    undefined,
    undefined,
    undefined,
    ids,
    1,
  );
});

test('changing the selected video keeps saved RTMP secrets and rejects active or foreign changes', async () => {
  await withFixture(async ({ service, configs, children, setAccountStatus }) => {
    const first = await service.uploadVideo(owner, 'first.mp4', Readable.from(mp4));
    const second = await service.uploadVideo(owner, 'second.mp4', Readable.from(mp4));
    const initial = await service.selectVideo(owner, accountId, first.id);
    assert.equal(initial.videoId, first.id);
    assert.equal(initial.hasRtmpConfig, false);
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
  await withFixture(async ({ service, accountStore, children, setProbe }) => {
    const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
    setProbe(false);
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
  });
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
        streamId: '2234567890123456789',
        rtmpUrl: 'rtmps://example.invalid/live',
        streamKey: secret,
      };
    },
  );
});

test('start creates a room from the selected video and stop finishes that room', async () => {
  const created: string[] = [];
  const ended: string[] = [];
  await withFixture(
    async ({ service, children, configs }) => {
      const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
      await service.selectVideo(owner, accountId, video.id);
      const started = await service.startAuto(owner, accountId, 'Test LIVE');
      assert.equal(started.roomId, '1234567890123456789');
      assert.equal(started.session.status, 'starting');
      assert.equal(configs.get(accountId)?.streamId, '2234567890123456789');
      children[0].progress();
      const stopped = await service.stopAndEnd(owner, accountId);
      assert.equal(stopped.session.status, 'idle');
      assert.equal(stopped.roomEnd, 'ended');
      assert.deepEqual(created, ['Test LIVE']);
      assert.deepEqual(ended, ['1234567890123456789']);
    },
    true,
    undefined,
    async ({ title }) => {
      created.push(title);
      return {
        roomId: '1234567890123456789',
        streamId: '2234567890123456789',
        rtmpUrl: 'rtmps://example.invalid/live',
        streamKey: secret,
      };
    },
    async ({ roomId }) => {
      ended.push(roomId ?? '');
      return 'ended';
    },
  );
});

test('a video selection storage error cannot leave a newly created room behind', async () => {
  let created = false;
  await withFixture(
    async ({ service, store }) => {
      const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
      await service.configure(owner, accountId, {
        rtmpUrl: 'rtmps://example.invalid/live',
        streamKey: secret,
        videoId: video.id,
      });
      store.savePreferredVideoId = async () => {
        throw new Error('database error');
      };
      await assert.rejects(service.startAuto(owner, accountId, 'Test LIVE'));
      assert.equal(created, false);
    },
    true,
    undefined,
    async () => {
      created = true;
      return {
        roomId: '1234567890123456789',
        streamId: '2234567890123456789',
        rtmpUrl: 'rtmps://example.invalid/live',
        streamKey: secret,
      };
    },
  );
});

test('a room is sent a finish request if saving its destination fails', async () => {
  let finishedRoomId = '';
  await withFixture(
    async ({ service, store }) => {
      const video = await service.uploadVideo(owner, 'clip.mp4', Readable.from(mp4));
      await service.selectVideo(owner, accountId, video.id);
      store.saveConfig = async () => {
        throw new Error('database error');
      };
      await assert.rejects(
        service.startAuto(owner, accountId, 'Test LIVE'),
        (error: unknown) => error instanceof LiveError && error.statusCode === 503,
      );
      assert.equal(finishedRoomId, '1234567890123456789');
    },
    true,
    undefined,
    async () => ({
      roomId: '1234567890123456789',
      streamId: '2234567890123456789',
      rtmpUrl: 'rtmps://example.invalid/live',
      streamKey: secret,
    }),
    async ({ roomId }) => {
      finishedRoomId = roomId ?? '';
      return 'ended';
    },
  );
});

test('chunked uploads accept out-of-order chunks, resume from disk, and finalize like a normal upload', async () => {
  await withFixture(async ({ service }) => {
    const total = 40 * 1024 * 1024;
    const data = Buffer.alloc(total, 7);
    mp4.copy(data, 0);
    const created = await service.createUpload(owner, 'big.mp4', total);
    assert.equal(created.total, 2);
    assert.deepEqual(created.received, []);
    const second = data.subarray(created.chunkSize);
    const first = data.subarray(0, created.chunkSize);
    await service.writeUploadChunk(owner, created.uploadId, 1, Readable.from(second));
    await assert.rejects(
      service.writeUploadChunk(owner, created.uploadId, 0, Readable.from(first.subarray(10))),
      (error: unknown) => error instanceof LiveError && error.statusCode === 400,
    );
    await assert.rejects(
      service.uploadStatus('other-owner', created.uploadId),
      (error: unknown) => error instanceof LiveError && error.statusCode === 404,
    );
    await assert.rejects(
      service.completeUpload(owner, created.uploadId),
      (error: unknown) => error instanceof LiveError && error.statusCode === 409,
    );
    (service as unknown as { chunkedUploads: Map<string, unknown> }).chunkedUploads.clear();
    assert.deepEqual((await service.uploadStatus(owner, created.uploadId)).received, [1]);
    await service.writeUploadChunk(owner, created.uploadId, 0, Readable.from(first));
    const started = await service.completeUpload(owner, created.uploadId);
    assert.equal(started.state, 'processing');
    let finished = await service.uploadStatus(owner, created.uploadId);
    for (let attempt = 0; attempt < 100 && finished.state === 'processing'; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      finished = await service.uploadStatus(owner, created.uploadId);
    }
    assert.equal(finished.state, 'done');
    const item = finished.item!;
    assert.equal(item.name, 'big.mp4');
    assert.equal(item.sizeBytes, total);
    assert.deepEqual(await service.listVideos(owner), [item]);
    await assert.rejects(
      service.createUpload(owner, '../x.mp4', total),
      (error: unknown) => error instanceof LiveError && error.statusCode === 400,
    );
    await assert.rejects(
      service.createUpload(owner, 'huge.mp4', 9 * 1024 * 1024 * 1024),
      (error: unknown) => error instanceof LiveError && error.statusCode === 413,
    );
  });
});

test('video playback streams byte ranges for the owner only and refuses unfinished videos', async () => {
  await withFixture(async ({ service, accountStore }) => {
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
    const url = `/api/v1/live/videos/${upload.json().item.id}/file`;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'GET', url, headers: { ...headers, 'x-livehub-owner': 'x2' } }))
        .statusCode,
      404,
    );
    const whole = await app.inject({ method: 'GET', url, headers });
    assert.equal(whole.statusCode, 200);
    assert.deepEqual(whole.rawPayload, mp4);
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    const part = await app.inject({
      method: 'GET',
      url,
      headers: { ...headers, range: 'bytes=4-7' },
    });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], `bytes 4-7/${mp4.length}`);
    assert.deepEqual(part.rawPayload, mp4.subarray(4, 8));
    const tail = await app.inject({
      method: 'GET',
      url,
      headers: { ...headers, range: 'bytes=-4' },
    });
    assert.equal(tail.statusCode, 206);
    assert.deepEqual(tail.rawPayload, mp4.subarray(mp4.length - 4));
    const beyond = await app.inject({
      method: 'GET',
      url,
      headers: { ...headers, range: 'bytes=500-600' },
    });
    assert.equal(beyond.statusCode, 416);
    await app.close();
  });
});
