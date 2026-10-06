/**
 * In-memory relay between the hosted web app and the Boxphone bridge on the computer that holds the phones.
 * The computer's agent long-polls for jobs over HTTPS and posts results back, so no inbound port is opened.
 * Jobs live in this process only; the web service must run as a single replica.
 */
export type RelayJob = {
  id: string;
  action: string;
  method: 'GET' | 'POST';
  owner: string;
  body: string | null;
};
export type RelayResult = { status: number; body: string };

export class RelayError extends Error {
  constructor(
    message: string,
    public status = 503,
  ) {
    super(message);
  }
}

export const AGENT_ONLINE_MS = 45_000;
const MAX_PENDING = 50;
const MAX_BODY_CHARS = 48 * 1024 * 1024;

type Waiter = { resolve: (job: RelayJob | null) => void; timer: ReturnType<typeof setTimeout> };
type Pending = {
  resolve: (r: RelayResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type State = {
  queue: RelayJob[];
  waiters: Waiter[];
  open: Map<string, Pending>;
  lastSeen: number;
  counter: number;
};

const holder = globalThis as typeof globalThis & { __boxphoneRelay?: State };
const state = (): State =>
  (holder.__boxphoneRelay ??= { queue: [], waiters: [], open: new Map(), lastSeen: 0, counter: 0 });

export function agentOnline(now = Date.now()): boolean {
  return now - state().lastSeen < AGENT_ONLINE_MS;
}

/** Hand a job to the agent and wait for its result. Fails fast when no agent is connected. */
export function submitJob(job: Omit<RelayJob, 'id'>, timeoutMs = 125_000): Promise<RelayResult> {
  const s = state();
  if (!agentOnline())
    return Promise.reject(
      new RelayError(
        'คอมที่ต่อโทรศัพท์ยังไม่เชื่อมต่อ ตรวจว่าเปิดเครื่องอยู่และตัวเชื่อม Boxphone ทำงานอยู่',
      ),
    );
  if ((job.body?.length ?? 0) > MAX_BODY_CHARS)
    return Promise.reject(new RelayError('ข้อมูลยาวเกินไป', 413));
  if (s.open.size >= MAX_PENDING)
    // every queued job is also open until its result arrives
    return Promise.reject(new RelayError('มีคำสั่งค้างมากเกินไป กรุณารอสักครู่', 429));
  const id = `${Date.now().toString(36)}-${(s.counter += 1)}-${Math.random().toString(36).slice(2, 8)}`;
  const full: RelayJob = { ...job, id };
  return new Promise<RelayResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.open.delete(id);
      const index = s.queue.findIndex((j) => j.id === id);
      if (index >= 0) s.queue.splice(index, 1);
      reject(new RelayError('คอมที่ต่อโทรศัพท์ไม่ตอบกลับทันเวลา', 504));
    }, timeoutMs);
    s.open.set(id, { resolve, reject, timer });
    const waiter = s.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(full);
    } else s.queue.push(full);
  });
}

/** The agent asks for its next job; resolves null when nothing arrives within waitMs. */
export function nextJob(waitMs = 25_000): Promise<RelayJob | null> {
  const s = state();
  s.lastSeen = Date.now();
  const ready = s.queue.shift();
  if (ready) return Promise.resolve(ready);
  return new Promise<RelayJob | null>((resolve) => {
    const waiter: Waiter = {
      resolve: (job) => {
        s.lastSeen = Date.now();
        resolve(job);
      },
      timer: setTimeout(() => {
        const index = s.waiters.indexOf(waiter);
        if (index >= 0) s.waiters.splice(index, 1);
        s.lastSeen = Date.now();
        resolve(null);
      }, waitMs),
    };
    s.waiters.push(waiter);
  });
}

/** The agent reports a finished job. Unknown or already timed-out ids are ignored. */
export function completeJob(id: string, result: RelayResult): boolean {
  const pending = state().open.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  state().open.delete(id);
  pending.resolve(result);
  return true;
}

/** Test helper: forget everything. */
export function resetRelay(): void {
  const s = state();
  for (const w of s.waiters) clearTimeout(w.timer);
  for (const p of s.open.values()) clearTimeout(p.timer);
  holder.__boxphoneRelay = undefined;
}
