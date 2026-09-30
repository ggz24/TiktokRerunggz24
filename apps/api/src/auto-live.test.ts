import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { AccountStore } from './accounts.js';
import { AutoLiveManager, parseAutoSettings, type AutoSettings } from './auto-live.js';
import type { LiveService } from './live-service.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const ownerId = 'admin';

function harness(settings: AutoSettings, phase: 'idle' | 'live' | 'resting' = 'idle') {
  let now = new Date('2026-09-30T09:59:00.000Z');
  let status = 'idle';
  let roomState: 'open' | 'closed' = 'open';
  let roomCheckFails = false;
  const calls = { started: 0, resumed: 0, stopped: 0 };
  const row = {
    owner_id: ownerId,
    account_id: accountId,
    settings,
    phase,
    phase_started_at: phase === 'live' ? new Date(now) : (null as Date | null),
    retry_at: null as Date | null,
    last_schedule_day: null as string | null,
    last_error: null as string | null,
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith('SELECT * FROM livehub_auto_live')) return { rows: [row] };
      if (sql.includes("phase = 'live'")) {
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
    async session() {
      return { status, hasOpenRoom: false };
    },
    async startAuto() {
      calls.started++;
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

  const restart = harness({ ...settings, closedRoomAction: 'new_room' }, 'live');
  restart.setStatus('failed');
  restart.setRoomState('closed');
  await restart.manager.tick();
  assert.equal(restart.calls.started, 1);

  const unknown = harness({ ...settings, closedRoomAction: 'new_room' }, 'live');
  unknown.setStatus('failed');
  unknown.failRoomCheck();
  await unknown.manager.tick();
  assert.equal(unknown.calls.started, 0);
  assert.equal(unknown.row.phase, 'live');
  assert.match(unknown.row.last_error ?? '', /unknown/);
});
