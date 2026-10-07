import type { Pool } from 'pg';
import type { AccountStore } from './accounts.js';
import { LiveError, type LiveService } from './live-service.js';
import {
  roundPlan,
  type RoundSettings,
  type RoundPlan,
  type RoundActions,
  type RoundProductOutcome,
} from './live-rounds.js';

export type AutoSettings = RoundSettings & {
  endAfterMinutes: number | null;
  restartAfterMinutes: number | null;
  dailyStartTime: string | null;
  recoverStream: boolean;
  closedRoomAction: 'new_room' | 'stop';
};
type Phase = 'idle' | 'live' | 'resting';
type Row = {
  owner_id: string;
  account_id: string;
  settings: AutoSettings;
  phase: Phase;
  phase_started_at: Date | null;
  retry_at: Date | null;
  last_schedule_day: string | null;
  last_error: string | null;
  round_index?: number;
  active_round?: RoundPlan | null;
  products_outcome?: RoundProductOutcome | null;
  pin_outcome?: RoundProductOutcome | null;
};
const defaults: AutoSettings = {
  endAfterMinutes: null,
  restartAfterMinutes: null,
  dailyStartTime: null,
  recoverStream: false,
  closedRoomAction: 'stop',
  videoRotation: [],
  productSetRotation: [],
  autoAddProducts: true,
  autoPinProduct: false,
  productPinSelections: {},
};

export function parseAutoSettings(value: unknown): AutoSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LiveError(400, 'Invalid AUTO settings.');
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => !Object.hasOwn(defaults, key)) ||
    [
      'endAfterMinutes',
      'restartAfterMinutes',
      'dailyStartTime',
      'recoverStream',
      'closedRoomAction',
    ].some((key) => !Object.hasOwn(raw, key))
  )
    throw new LiveError(400, 'Invalid AUTO settings.');
  const minutes = (input: unknown) =>
    input === null || (Number.isInteger(input) && Number(input) >= 1 && Number(input) <= 1440);
  if (
    !minutes(raw.endAfterMinutes) ||
    !minutes(raw.restartAfterMinutes) ||
    (raw.restartAfterMinutes !== null && raw.endAfterMinutes === null) ||
    (raw.dailyStartTime !== null &&
      (typeof raw.dailyStartTime !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.dailyStartTime))) ||
    typeof raw.recoverStream !== 'boolean' ||
    !['new_room', 'stop'].includes(String(raw.closedRoomAction))
  )
    throw new LiveError(400, 'Invalid AUTO settings.');
  const ids = (input: unknown) =>
    Array.isArray(input) &&
    input.length <= 100 &&
    input.every(
      (id) =>
        typeof id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    );
  for (const field of ['videoRotation', 'productSetRotation'])
    if (raw[field] !== undefined && !ids(raw[field]))
      throw new LiveError(400, 'Invalid round list.');
  for (const field of ['autoAddProducts', 'autoPinProduct'])
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean')
      throw new LiveError(400, 'Invalid product automation settings.');
  if (raw.productPinSelections !== undefined) {
    const picks = raw.productPinSelections;
    if (
      !picks ||
      typeof picks !== 'object' ||
      Array.isArray(picks) ||
      Object.keys(picks).length > 100 ||
      Object.entries(picks).some(
        ([id, product]) => !ids([id]) || typeof product !== 'string' || !/^\d{8,24}$/.test(product),
      )
    )
      throw new LiveError(400, 'Invalid product pin selections.');
  }
  return { ...defaults, ...raw } as AutoSettings;
}

export async function ensureAutoLiveTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS livehub_auto_live (
    account_id UUID PRIMARY KEY REFERENCES livehub_account_imports(id) ON DELETE CASCADE,
    owner_id VARCHAR(128) NOT NULL,
    settings JSONB NOT NULL,
    phase TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle','live','resting')),
    phase_started_at TIMESTAMPTZ,
    retry_at TIMESTAMPTZ,
    last_schedule_day VARCHAR(10),
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE livehub_auto_live
    ADD COLUMN IF NOT EXISTS round_index INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS active_round JSONB,
    ADD COLUMN IF NOT EXISTS products_outcome TEXT,
    ADD COLUMN IF NOT EXISTS pin_outcome TEXT`);
}

function bangkokDayTime(now: Date): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

export class AutoLiveManager {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly busy = new Set<string>();
  private readonly cancelled = new Map<string, number>();
  private roundActions?: RoundActions;
  private onRoomStarted?: (ownerId: string, accountId: string, roomId: string) => Promise<unknown>;

  constructor(
    private readonly pool: Pool,
    private readonly service: LiveService,
    private readonly accounts: AccountStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setRoundActions(actions: RoundActions): void {
    this.roundActions = actions;
  }

  setOnRoomStarted(
    callback: (ownerId: string, accountId: string, roomId: string) => Promise<unknown>,
  ): void {
    this.onRoomStarted = callback;
  }

  async get(ownerId: string, accountId: string) {
    await this.service.session(ownerId, accountId);
    const result = await this.pool.query<Row>(
      'SELECT * FROM livehub_auto_live WHERE owner_id = $1 AND account_id = $2',
      [ownerId, accountId],
    );
    const row = result.rows[0];
    return {
      settings: { ...defaults, ...row?.settings },
      phase: row?.phase ?? 'idle',
      phaseStartedAt: row?.phase_started_at?.toISOString() ?? null,
      lastError: row?.last_error ?? null,
      completedRounds: row?.round_index ?? 0,
      activeRound: row?.active_round ?? null,
      nextRound: roundPlan({ ...defaults, ...row?.settings }, row?.round_index ?? 0),
      productsOutcome: row?.products_outcome ?? null,
      pinOutcome: row?.pin_outcome ?? null,
    };
  }

  async save(ownerId: string, accountId: string, input: unknown) {
    if (this.busy.has(`${ownerId}\0${accountId}`))
      throw new LiveError(409, 'กำลังเริ่มหรือเปลี่ยนรอบไลฟ์ กรุณารอแล้วบันทึกอีกครั้ง');
    const settings = parseAutoSettings(input);
    const session = await this.service.session(ownerId, accountId);
    const videos = settings.videoRotation || [];
    if (videos.length) {
      const owned = await this.service.listVideos(ownerId);
      if (
        videos.some((id) => !owned.some((v) => v.id === id && (!v.status || v.status === 'ready')))
      )
        throw new LiveError(422, 'เลือกคลิปที่พร้อมใช้งานจากคลังของคุณเท่านั้น');
    }
    await this.roundActions?.validate(ownerId, accountId, settings);
    await this.pool.query(
      `INSERT INTO livehub_auto_live (owner_id, account_id, settings)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (account_id) DO UPDATE SET
       round_index=CASE WHEN COALESCE(livehub_auto_live.settings->'videoRotation','[]'::jsonb) IS DISTINCT FROM EXCLUDED.settings->'videoRotation'
         OR COALESCE(livehub_auto_live.settings->'productSetRotation','[]'::jsonb) IS DISTINCT FROM EXCLUDED.settings->'productSetRotation' THEN 0 ELSE livehub_auto_live.round_index END,
       settings = EXCLUDED.settings, updated_at = NOW()
       WHERE livehub_auto_live.owner_id = EXCLUDED.owner_id`,
      [ownerId, accountId, JSON.stringify(settings)],
    );
    const current = await this.get(ownerId, accountId);
    if (
      !session.videoId &&
      videos.length &&
      session.status !== 'live' &&
      session.status !== 'starting'
    )
      await this.service.selectVideo(ownerId, accountId, videos[0]);
    if (
      current.phase === 'idle' &&
      session.hasOpenRoom &&
      (session.status === 'live' || session.status === 'starting')
    )
      await this.onStarted(ownerId, accountId);
    return this.get(ownerId, accountId);
  }

  async onStarted(ownerId: string, accountId: string): Promise<void> {
    const now = this.now();
    const day = bangkokDayTime(now).day;
    await this.pool.query(
      `UPDATE livehub_auto_live SET phase = 'live', phase_started_at = $3,
       retry_at = NULL, last_error = NULL, last_schedule_day = $4, updated_at = NOW()
       WHERE owner_id = $1 AND account_id = $2`,
      [ownerId, accountId, now, day],
    );
  }

  async onStopped(ownerId: string, accountId: string): Promise<void> {
    const key = `${ownerId}\0${accountId}`;
    this.cancelled.set(key, (this.cancelled.get(key) ?? 0) + 1);
    await this.pool.query(
      `UPDATE livehub_auto_live SET phase = 'idle', phase_started_at = NULL,
       retry_at = NULL, updated_at = NOW()
       WHERE owner_id = $1 AND account_id = $2`,
      [ownerId, accountId],
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.pool.query<Row>('SELECT * FROM livehub_auto_live');
      // Run independent accounts concurrently without flooding the database or room API.
      for (let offset = 0; offset < result.rows.length; offset += 8) {
        await Promise.all(result.rows.slice(offset, offset + 8).map((row) => this.advanceRow(row)));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async advanceRow(row: Row): Promise<void> {
    const key = `${row.owner_id}\0${row.account_id}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      await this.advance(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AUTO action failed.';
      await this.pool
        .query(
          `UPDATE livehub_auto_live SET last_error = $3, retry_at = $4, updated_at = NOW()
           WHERE owner_id = $1 AND account_id = $2`,
          [
            row.owner_id,
            row.account_id,
            message.slice(0, 300),
            new Date(this.now().getTime() + 30_000),
          ],
        )
        .catch(() => undefined);
    } finally {
      this.busy.delete(key);
    }
  }

  async startRoom(ownerId: string, accountId: string, title: string) {
    const key = `${ownerId}\0${accountId}`;
    if (this.busy.has(key)) throw new LiveError(409, 'กำลังเริ่มรอบไลฟ์ กรุณารอ');
    this.busy.add(key);
    try {
      const result = await this.pool.query<Row>(
        'SELECT * FROM livehub_auto_live WHERE owner_id = $1 AND account_id = $2',
        [ownerId, accountId],
      );
      const row = result.rows[0] ?? {
        owner_id: ownerId,
        account_id: accountId,
        settings: { ...defaults },
        phase: 'idle' as const,
        phase_started_at: null,
        retry_at: null,
        last_schedule_day: null,
        last_error: null,
      };
      return await this.startRound(row, title);
    } finally {
      this.busy.delete(key);
    }
  }

  private async startRound(row: Row, title: string) {
    const key = `${row.owner_id}\0${row.account_id}`;
    const generation = this.cancelled.get(key) ?? 0;
    const checkCancelled = () => {
      if ((this.cancelled.get(key) ?? 0) !== generation)
        throw new LiveError(409, 'ยกเลิกการเริ่มรอบไลฟ์แล้ว');
    };
    const settings = { ...defaults, ...row.settings },
      plan = roundPlan(settings, row.round_index ?? 0);
    await this.roundActions?.validate(row.owner_id, row.account_id, settings);
    checkCancelled();
    let productsOutcome: RoundProductOutcome = 'none';
    const result = await this.service.startAuto(row.owner_id, row.account_id, title, {
      videoId: plan.videoId,
      beforeStream: async (room) => {
        checkCancelled();
        if (this.roundActions)
          productsOutcome = await this.roundActions
            .beforeStream(row.owner_id, row.account_id, room, plan)
            .catch(() => 'unverified' as const);
        checkCancelled();
      },
    });
    checkCancelled();
    await this.onStarted(row.owner_id, row.account_id);
    await this.pool.query(
      `INSERT INTO livehub_auto_live(owner_id,account_id,settings,phase,phase_started_at,last_schedule_day,round_index,active_round,products_outcome,pin_outcome)
      VALUES($1,$2,$3::jsonb,'live',$4,$5,1,$6::jsonb,$7,NULL)
      ON CONFLICT(account_id) DO UPDATE SET round_index=livehub_auto_live.round_index+1,active_round=EXCLUDED.active_round,
      products_outcome=EXCLUDED.products_outcome,pin_outcome=NULL,updated_at=NOW()
      WHERE livehub_auto_live.owner_id=EXCLUDED.owner_id`,
      [
        row.owner_id,
        row.account_id,
        JSON.stringify(settings),
        this.now(),
        bangkokDayTime(this.now()).day,
        JSON.stringify(plan),
        productsOutcome,
      ],
    );
    let pinOutcome: RoundProductOutcome = 'none';
    if (this.roundActions)
      pinOutcome = await this.roundActions
        .afterStream(row.owner_id, row.account_id, result.roomId, plan, productsOutcome)
        .catch(() => 'unverified' as const);
    else if (this.onRoomStarted)
      productsOutcome = await this.onRoomStarted(row.owner_id, row.account_id, result.roomId)
        .then((x) => x as RoundProductOutcome)
        .catch(() => 'unverified' as const);
    const failed = [productsOutcome, pinOutcome].some(
      (x) => x === 'rejected' || x === 'unverified',
    );
    await this.pool.query(
      `UPDATE livehub_auto_live SET products_outcome=$3,pin_outcome=$4,last_error=$5 WHERE owner_id=$1 AND account_id=$2`,
      [
        row.owner_id,
        row.account_id,
        productsOutcome,
        pinOutcome,
        failed ? 'สินค้า/ปักหมุดยังไม่สำเร็จ ตรวจ session และสินค้าในตะกร้า LIVE' : null,
      ],
    );
    return { ...result, productsOutcome, pinOutcome, round: plan.index + 1 };
  }

  private async startNew(row: Row): Promise<void> {
    const account = (await this.accounts.list(row.owner_id)).find(
      (item) => item.id === row.account_id,
    );
    if (!account?.liveTitle?.trim()) throw new Error('Set a LIVE title before AUTO start.');
    await this.startRound(row, account.liveTitle);
  }

  private async advance(row: Row): Promise<void> {
    const now = this.now();
    if (row.retry_at && now < row.retry_at) return;
    const settings = row.settings;
    const { day, time } = bangkokDayTime(now);
    if (row.phase === 'idle') {
      if (
        !settings.dailyStartTime ||
        time < settings.dailyStartTime ||
        row.last_schedule_day === day
      )
        return;
      const session = await this.service.session(row.owner_id, row.account_id);
      if (session.status === 'live' || session.status === 'starting') return;
      if (session.hasOpenRoom) await this.service.clearClosedRoom(row.owner_id, row.account_id);
      await this.startNew(row);
      return;
    }
    if (row.phase === 'resting') {
      if (!settings.restartAfterMinutes || !row.phase_started_at)
        return this.onStopped(row.owner_id, row.account_id);
      if (now.getTime() - row.phase_started_at.getTime() >= settings.restartAfterMinutes * 60_000)
        await this.startNew(row);
      return;
    }
    const session = await this.service.session(row.owner_id, row.account_id);
    if (
      settings.endAfterMinutes &&
      row.phase_started_at &&
      now.getTime() - row.phase_started_at.getTime() >= settings.endAfterMinutes * 60_000
    ) {
      const result = await this.service.stopAndEnd(row.owner_id, row.account_id);
      if (result.roomEnd !== 'ended' && result.roomEnd !== 'no_room')
        throw new Error('TikTok room closure is unverified; AUTO is paused.');
      if (settings.restartAfterMinutes) {
        await this.pool.query(
          `UPDATE livehub_auto_live SET phase = 'resting', phase_started_at = $3,
           retry_at = NULL, last_error = NULL WHERE owner_id = $1 AND account_id = $2`,
          [row.owner_id, row.account_id, now],
        );
      } else await this.onStopped(row.owner_id, row.account_id);
      return;
    }
    if (session.status === 'live' || session.status === 'starting' || session.status === 'stopping')
      return;
    if (!settings.recoverStream) return this.onStopped(row.owner_id, row.account_id);
    const room = await this.service.currentRoomState(row.owner_id, row.account_id);
    if (room === 'open') {
      await this.service.start(row.owner_id, row.account_id);
      await this.pool.query(
        `UPDATE livehub_auto_live SET retry_at = $3, last_error = NULL WHERE owner_id = $1 AND account_id = $2`,
        [row.owner_id, row.account_id, new Date(now.getTime() + 30_000)],
      );
    } else if (settings.closedRoomAction === 'new_room') {
      await this.service.clearClosedRoom(row.owner_id, row.account_id);
      await this.startNew(row);
    } else {
      await this.service.clearClosedRoom(row.owner_id, row.account_id);
      await this.onStopped(row.owner_id, row.account_id);
    }
  }
}
