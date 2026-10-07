import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { AccountStore } from './accounts.js';
import { AutoLiveManager, parseAutoSettings, type AutoSettings } from './auto-live.js';
import type { LiveService } from './live-service.js';
import { roundPlan } from './live-rounds.js';

test('pin selections follow the selected set across rotating rounds and reject malformed settings', () => {
  const settings = {
    endAfterMinutes: null,
    restartAfterMinutes: null,
    dailyStartTime: null,
    recoverStream: false,
    closedRoomAction: 'stop',
    productSetRotation: ['11111111-1111-4111-8111-111111111111'],
    productPinSelections: { '11111111-1111-4111-8111-111111111111': '987654321' },
  };
  const parsed = parseAutoSettings(settings);
  assert.equal(roundPlan(parsed, 3).pinProductId, '987654321');
  assert.throws(() =>
    parseAutoSettings({ ...settings, productPinSelections: { bad: '987654321' } }),
  );
  assert.throws(() =>
    parseAutoSettings({
      ...settings,
      productPinSelections: { '11111111-1111-4111-8111-111111111111': 987654321 },
    }),
  );
});

const accountId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'admin';

function harness(settings: AutoSettings, phase: 'idle' | 'live' | 'resting' = 'idle') {
  let now = new Date('2026-09-30T09:59:00.000Z');
  let status = 'idle';
  let roomState: 'open' | 'closed' = 'open';
  let roomCheckFails = false;
  const calls = {
    started: 0,
    resumed: 0,
    stopped: 0,
    cleared: 0,
    videos: [] as (string | undefined)[],
  };
  let startFails = false;
  const row = {
    owner_id: ownerId,
    account_id: accountId,
    settings,
    phase,
    phase_started_at: phase === 'live' ? new Date(now) : (null as Date | null),
    retry_at: null as Date | null,
    last_schedule_day: null as string | null,
    last_error: null as string | null,
    round_index: 0,
    active_round: null as unknown,
    products_outcome: null as unknown,
    pin_outcome: null as unknown,
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith('SELECT * FROM livehub_auto_live')) return { rows: [row] };
      if (sql.includes('round_index=livehub_auto_live.round_index+1')) {
        row.round_index++;
        row.active_round = JSON.parse(params?.[5] as string);
      } else if (sql.includes('round_index=CASE')) {
        const next = JSON.parse(params?.[2] as string);
        if (
          JSON.stringify(row.settings.videoRotation ?? []) !== JSON.stringify(next.videoRotation) ||
          JSON.stringify(row.settings.productSetRotation ?? []) !==
            JSON.stringify(next.productSetRotation)
        )
          row.round_index = 0;
        row.settings = next;
      } else if (sql.includes('products_outcome=$3')) {
        row.products_outcome = params?.[2];
        row.pin_outcome = params?.[3];
        row.last_error = params?.[4] as string | null;
      } else if (sql.includes("phase = 'live'")) {
        row.phase = 'live';
        row.phase_started_at = params?.[2] as Date;
        row.last_schedule_day = params?.[3] as string;
        row.retry_at = null;
        row.last_error = null;
      } else if (sql.includes("phase = 'resting'")) {
        row.phase = 'resting';
        row.phase_started_at = params?.[2] as Date;
        row.retry_at = null;
        row.last_error = null;
      } else if (sql.includes("phase = 'idle'")) {
        row.phase = 'idle';
        row.phase_started_at = null;
        row.retry_at = null;
      } else if (sql.includes('last_error = $3')) {
        row.last_error = params?.[2] as string;
        row.retry_at = params?.[3] as Date;
      } else if (sql.includes('retry_at = $3')) {
        row.retry_at = params?.[2] as Date;
        row.last_error = null;
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const service = {
    async listVideos() {
      return [{ id: accountId, status: 'ready' }];
    },
    async selectVideo() {},
    async session() {
      return { status, hasOpenRoom: false };
    },
    async startAuto(
      _owner: string,
      _account: string,
      _title: string,
      options?: { videoId?: string; beforeStream?: (room: string) => Promise<unknown> },
    ) {
      if (startFails) throw Error('Room creation failed');
      await options?.beforeStream?.('12345678');
      calls.started++;
      calls.videos.push(options?.videoId);
      status = 'live';
      return { roomId: '12345678', session: {} };
    },
    async start() {
      calls.resumed++;
      status = 'live';
      return {};
    },
    async stopAndEnd() {
      calls.stopped++;
      status = 'idle';
      return { roomEnd: 'ended', session: {} };
    },
    async currentRoomState() {
      if (roomCheckFails) throw new Error('Room state unknown.');
      return roomState;
    },
    async clearClosedRoom() {
      calls.cleared++;
    },
  } as unknown as LiveService;
  const accounts = {
    async list() {
      return [{ id: accountId, liveTitle: 'My LIVE' }];
    },
  } as unknown as AccountStore;
  const manager = new AutoLiveManager(pool, service, accounts, () => now);
  return {
    manager,
    row,
    calls,
    setNow(value: string) {
      now = new Date(value);
    },
    setStatus(value: string) {
      status = value;
    },
    setRoomState(value: 'open' | 'closed') {
      roomState = value;
    },
    failRoomCheck() {
      roomCheckFails = true;
    },
    failStart(value: boolean) {
      startFails = value;
    },
    reload() {
      return new AutoLiveManager(pool, service, accounts, () => now);
    },
  };
}

test('AUTO settings reject invalid cycles and times', () => {
  assert.throws(() =>
    parseAutoSettings({
      endAfterMinutes: null,
      restartAfterMinutes: 5,
      dailyStartTime: null,
      recoverStream: false,
      closedRoomAction: 'stop',
    }),
  );
  assert.throws(() =>
    parseAutoSettings({
      endAfterMinutes: 10,
      restartAfterMinutes: null,
      dailyStartTime: '25:00',
      recoverStream: false,
      closedRoomAction: 'stop',
    }),
  );
});

test('round lists allow repeated selections but reject malformed, oversized and unknown settings', () => {
  const base = {
    endAfterMinutes: null,
    restartAfterMinutes: null,
    dailyStartTime: null,
    recoverStream: false,
    closedRoomAction: 'stop',
  };
  const parsed = parseAutoSettings({
    ...base,
    videoRotation: [accountId, accountId],
    autoAddProducts: false,
  });
  assert.deepEqual(parsed.videoRotation, [accountId, accountId]);
  assert.deepEqual(parsed.productSetRotation, []);
  for (const patch of [
    { videoRotation: ['not-an-id'] },
    { productSetRotation: Array(101).fill(accountId) },
    { autoPinProduct: 'true' },
    { unknown: true },
  ])
    assert.throws(() => parseAutoSettings({ ...base, ...patch }));
});

test('clips and product sets rotate once per new room and survive manager reload', async () => {
  const v1 = '11111111-1111-4111-8111-111111111111',
    v2 = '22222222-2222-4222-8222-222222222222';
  const h = harness({
    endAfterMinutes: 10,
    restartAfterMinutes: 5,
    dailyStartTime: '17:00',
    recoverStream: true,
    closedRoomAction: 'new_room',
    videoRotation: [v1, v2, v1],
    productSetRotation: [v2, v1],
    autoAddProducts: true,
    autoPinProduct: true,
  });
  const applied: number[] = [],
    pinned: number[] = [];
  h.manager.setRoundActions({
    validate: async () => {},
    beforeStream: async (_o, _a, _r, p) => {
      applied.push(p.index);
      return 'accepted';
    },
    afterStream: async (_o, _a, _r, p) => {
      pinned.push(p.index);
      return 'accepted';
    },
  });
  h.setNow('2026-09-30T10:00:00.000Z');
  await h.manager.tick();
  h.setNow('2026-09-30T10:10:00.000Z');
  await h.manager.tick();
  h.setNow('2026-09-30T10:15:00.000Z');
  await h.manager.tick();
  assert.deepEqual(h.calls.videos, [v1, v2]);
  assert.equal(h.row.round_index, 2);
  h.setStatus('failed');
  await h.manager.tick();
  assert.equal(h.calls.resumed, 1);
  assert.equal(h.row.round_index, 2);
  h.setNow('2026-09-30T10:16:00.000Z');
  h.setStatus('failed');
  h.setRoomState('closed');
  await h.manager.tick();
  assert.deepEqual(h.calls.videos, [v1, v2, v1]);
  assert.equal(h.row.round_index, 3);
  assert.deepEqual(applied, [0, 1, 2]);
  assert.deepEqual(pinned, [0, 1, 2]);
  const current = await h.manager.get(ownerId, accountId);
  assert.equal(current.nextRound.videoId, v1);
  assert.equal(current.nextRound.productSetId, v1);
  const reloaded = h.reload();
  h.setNow('2026-09-30T10:26:00.000Z');
  await reloaded.tick();
  h.setNow('2026-09-30T10:31:00.000Z');
  await reloaded.tick();
  assert.equal(h.row.round_index, 4);
  assert.deepEqual(h.calls.videos, [v1, v2, v1, v1]);
});

test('round settings reject unavailable videos, keep cursor for timer edits and reset it for changed lists', async () => {
  const base: AutoSettings = {
    endAfterMinutes: null,
    restartAfterMinutes: null,
    dailyStartTime: null,
    recoverStream: false,
    closedRoomAction: 'stop',
    videoRotation: [accountId],
    productSetRotation: [],
  };
  const h = harness(base);
  h.row.round_index = 3;
  await h.manager.save(ownerId, accountId, { ...base, endAfterMinutes: 15 });
  assert.equal(h.row.round_index, 3);
  await assert.rejects(
    h.manager.save(ownerId, accountId, {
      ...base,
      videoRotation: ['22222222-2222-4222-8222-222222222222'],
    }),
  );
  await h.manager.save(ownerId, accountId, { ...base, videoRotation: [accountId, accountId] });
  assert.equal(h.row.round_index, 0);
});

test('stop during product preparation cancels the pending stream without consuming a round', async () => {
  const h = harness({
    endAfterMinutes: null,
    restartAfterMinutes: null,
    dailyStartTime: null,
    recoverStream: false,
    closedRoomAction: 'stop',
  });
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    waiting = new Promise<void>((r) => (release = r));
  h.manager.setRoundActions({
    validate: async () => {},
    beforeStream: async () => {
      entered();
      await waiting;
      return 'accepted';
    },
    afterStream: async () => {
      throw Error('Should not pin');
    },
  });
  const pending = h.manager.startRoom(ownerId, accountId, 'Test');
  await ready;
  await h.manager.onStopped(ownerId, accountId);
  release();
  await assert.rejects(pending, /ยกเลิก/);
  assert.equal(h.calls.started, 0);
  assert.equal(h.row.round_index, 0);
  assert.equal(h.row.phase, 'idle');
});

test('failed room creation does not skip a round; product failure does not create a second room', async () => {
  const h = harness({
    endAfterMinutes: null,
    restartAfterMinutes: null,
    dailyStartTime: '17:00',
    recoverStream: false,
    closedRoomAction: 'stop',
    videoRotation: [accountId],
  });
  h.setNow('2026-09-30T10:00:00.000Z');
  h.failStart(true);
  await h.manager.tick();
  assert.equal(h.row.round_index, 0);
  h.setNow('2026-09-30T10:01:00.000Z');
  h.failStart(false);
  h.manager.setRoundActions({
    validate: async () => {},
    beforeStream: async () => 'rejected',
    afterStream: async () => 'unverified',
  });
  await h.manager.tick();
  assert.equal(h.row.round_index, 1);
  assert.equal(h.calls.started, 1);
  assert.match(h.row.last_error || '', /สินค้า/);
  await h.manager.tick();
  assert.equal(h.calls.started, 1);
});

test('AUTO starts more than ten independent accounts in bounded parallel batches', async () => {
  const ids = Array.from(
    { length: 12 },
    (_, index) => `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
  );
  const rows = ids.map((id) => ({
    owner_id: ownerId,
    account_id: id,
    settings: {
      endAfterMinutes: null,
      restartAfterMinutes: null,
      dailyStartTime: '17:00',
      recoverStream: false,
      closedRoomAction: 'stop' as const,
    },
    phase: 'idle' as const,
    phase_started_at: null,
    retry_at: null,
    last_schedule_day: null,
    last_error: null,
  }));
  let active = 0;
  let peak = 0;
  let started = 0;
  const pool = {
    async query(sql: string) {
      return { rows: sql.startsWith('SELECT * FROM livehub_auto_live') ? rows : [] };
    },
  } as unknown as Pool;
  const service = {
    async session() {
      return { status: 'idle', hasOpenRoom: false };
    },
    async startAuto() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      started++;
      return { roomId: '12345678', session: {} };
    },
  } as unknown as LiveService;
  const accounts = {
    async list() {
      return ids.map((id) => ({ id, liveTitle: 'My LIVE' }));
    },
  } as unknown as AccountStore;
  const manager = new AutoLiveManager(
    pool,
    service,
    accounts,
    () => new Date('2026-09-30T10:00:00.000Z'),
  );
  await manager.tick();
  assert.equal(started, 12);
  assert.ok(peak > 1 && peak <= 8);
});

test('daily start, timed end and rest restart run in order', async () => {
  const h = harness({
    endAfterMinutes: 10,
    restartAfterMinutes: 5,
    dailyStartTime: '17:00',
    recoverStream: false,
    closedRoomAction: 'stop',
  });
  await h.manager.tick();
  assert.equal(h.calls.started, 0);
  h.setNow('2026-09-30T10:00:00.000Z');
  await h.manager.tick();
  assert.equal(h.calls.started, 1);
  assert.equal(h.row.phase, 'live');
  h.setNow('2026-09-30T10:10:00.000Z');
  await h.manager.tick();
  assert.equal(h.calls.stopped, 1);
  assert.equal(h.row.phase, 'resting');
  h.setNow('2026-09-30T10:15:00.000Z');
  await h.manager.tick();
  assert.equal(h.calls.started, 2);
  assert.equal(h.row.phase, 'live');
});

test('failed stream resumes same room when it is open', async () => {
  const h = harness(
    {
      endAfterMinutes: null,
      restartAfterMinutes: null,
      dailyStartTime: null,
      recoverStream: true,
      closedRoomAction: 'new_room',
    },
    'live',
  );
  h.setStatus('failed');
  await h.manager.tick();
  assert.equal(h.calls.resumed, 1);
  assert.equal(h.calls.started, 0);
});

test('closed room obeys selected action; unknown state never creates a room', async () => {
  const settings: AutoSettings = {
    endAfterMinutes: null,
    restartAfterMinutes: null,
    dailyStartTime: null,
    recoverStream: true,
    closedRoomAction: 'stop',
  };
  const stop = harness(settings, 'live');
  stop.setStatus('failed');
  stop.setRoomState('closed');
  await stop.manager.tick();
  assert.equal(stop.row.phase, 'idle');
  assert.equal(stop.calls.started, 0);
  assert.equal(stop.calls.cleared, 1);

  const restart = harness({ ...settings, closedRoomAction: 'new_room' }, 'live');
  restart.setStatus('failed');
  restart.setRoomState('closed');
  await restart.manager.tick();
  assert.equal(restart.calls.started, 1);
  assert.equal(restart.calls.cleared, 1);

  const unknown = harness({ ...settings, closedRoomAction: 'new_room' }, 'live');
  unknown.setStatus('failed');
  unknown.failRoomCheck();
  await unknown.manager.tick();
  assert.equal(unknown.calls.started, 0);
  assert.equal(unknown.row.phase, 'live');
  assert.match(unknown.row.last_error ?? '', /unknown/);
});
