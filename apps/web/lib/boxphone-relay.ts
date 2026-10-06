/**
 * In-memory relay between the hosted web app and the computers that hold phones.
 * Each paired computer runs an agent that long-polls over HTTPS for its own jobs and posts results back,
 * so no inbound port is opened. Jobs live in this process only: the web service must run as a single replica.
 */
export type RelayJob = {
  id: string;
  action: string;
  method: 'GET' | 'POST';
  owner: string;
  body: string | null;
};
export type RelayResult = { status: number; body: string };
export type AgentIdentity = { id: string; owner: string; name: string };
export type OnlineAgent = { id: string; name: string; lastSeen: number };

export class RelayError extends Error {
  constructor(
    message: string,
    public status = 503,
  ) {
    super(message);
  }
}

export const AGENT_ONLINE_MS = 45_000;
const MAX_PENDING_PER_AGENT = 50;
const MAX_BODY_CHARS = 48 * 1024 * 1024;

type Waiter = { resolve: (job: RelayJob | null) => void; timer: ReturnType<typeof setTimeout> };
type Open = {
  agent: string;
  resolve: (r: RelayResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type AgentState = {
  identity: AgentIdentity;
  queue: RelayJob[];
  waiters: Waiter[];
  lastSeen: number;
};
type State = {
  agents: Map<string, AgentState>;
  open: Map<string, Open>;
  counter: number;
  serials: Map<string, Map<string, string>>;
};

const holder = globalThis as typeof globalThis & { __boxphoneRelay2?: State };
const state = (): State =>
  (holder.__boxphoneRelay2 ??= {
    agents: new Map(),
    open: new Map(),
    counter: 0,
    serials: new Map(),
  });

function agentState(identity: AgentIdentity): AgentState {
  const s = state();
  let a = s.agents.get(identity.id);
  if (!a) {
    a = { identity, queue: [], waiters: [], lastSeen: 0 };
    s.agents.set(identity.id, a);
  }
  a.identity = identity;
  return a;
}

/** Agents of one owner that polled recently. */
export function onlineAgents(owner: string, now = Date.now()): OnlineAgent[] {
  return [...state().agents.values()]
    .filter((a) => a.identity.owner === owner && now - a.lastSeen < AGENT_ONLINE_MS)
    .map((a) => ({ id: a.identity.id, name: a.identity.name, lastSeen: a.lastSeen }));
}

export function agentOnline(owner: string, now = Date.now()): boolean {
  return onlineAgents(owner, now).length > 0;
}

/** Hand a job to one computer and wait for its result. Fails fast when that computer is not connected. */
export function submitJob(
  agentId: string,
  job: Omit<RelayJob, 'id'>,
  timeoutMs = 125_000,
): Promise<RelayResult> {
  const s = state();
  const agent = s.agents.get(agentId);
  if (
    !agent ||
    agent.identity.owner !== job.owner ||
    Date.now() - agent.lastSeen >= AGENT_ONLINE_MS
  )
    return Promise.reject(
      new RelayError(
        'คอมที่ต่อโทรศัพท์ยังไม่เชื่อมต่อ ตรวจว่าเปิดเครื่องอยู่และตัวเชื่อม Boxphone ทำงานอยู่',
      ),
    );
  if ((job.body?.length ?? 0) > MAX_BODY_CHARS)
    return Promise.reject(new RelayError('ข้อมูลยาวเกินไป', 413));
  const pending = [...s.open.values()].filter((o) => o.agent === agentId).length;
  if (pending >= MAX_PENDING_PER_AGENT)
    return Promise.reject(new RelayError('มีคำสั่งค้างมากเกินไป กรุณารอสักครู่', 429));
  const id = `${Date.now().toString(36)}-${(s.counter += 1)}-${Math.random().toString(36).slice(2, 8)}`;
  const full: RelayJob = { ...job, id };
  return new Promise<RelayResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.open.delete(id);
      const index = agent.queue.findIndex((j) => j.id === id);
      if (index >= 0) agent.queue.splice(index, 1);
      reject(new RelayError('คอมที่ต่อโทรศัพท์ไม่ตอบกลับทันเวลา', 504));
    }, timeoutMs);
    s.open.set(id, { agent: agentId, resolve, reject, timer });
    const waiter = agent.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(full);
    } else agent.queue.push(full);
  });
}

/** An agent asks for its next job; resolves null when nothing arrives within waitMs. */
export function nextJob(identity: AgentIdentity, waitMs = 25_000): Promise<RelayJob | null> {
  const agent = agentState(identity);
  agent.lastSeen = Date.now();
  const ready = agent.queue.shift();
  if (ready) return Promise.resolve(ready);
  return new Promise<RelayJob | null>((resolve) => {
    const waiter: Waiter = {
      resolve: (job) => {
        agent.lastSeen = Date.now();
        resolve(job);
      },
      timer: setTimeout(() => {
        const index = agent.waiters.indexOf(waiter);
        if (index >= 0) agent.waiters.splice(index, 1);
        agent.lastSeen = Date.now();
        resolve(null);
      }, waitMs),
    };
    agent.waiters.push(waiter);
  });
}

/** An agent reports a finished job. Only the agent that was given the job can complete it. */
export function completeJob(agentId: string, id: string, result: RelayResult): boolean {
  const s = state();
  const pending = s.open.get(id);
  if (!pending || pending.agent !== agentId) return false;
  clearTimeout(pending.timer);
  s.open.delete(id);
  pending.resolve(result);
  return true;
}

/** Forget a removed computer so its queued jobs fail now instead of timing out. */
export function dropAgent(agentId: string): void {
  const s = state();
  const agent = s.agents.get(agentId);
  if (!agent) return;
  for (const w of agent.waiters) {
    clearTimeout(w.timer);
    w.resolve(null);
  }
  for (const [id, pending] of s.open) {
    if (pending.agent !== agentId) continue;
    clearTimeout(pending.timer);
    s.open.delete(id);
    pending.reject(new RelayError('คอมเครื่องนี้ถูกตัดการเชื่อมต่อแล้ว'));
  }
  s.agents.delete(agentId);
  for (const serials of s.serials.values())
    for (const [serial, owner] of serials) if (owner === agentId) serials.delete(serial);
}

// ---- phone -> computer routing ----
export type ComputerDevice = Record<string, unknown> & { serial: string };

function remember(owner: string, serial: string, agentId: string): void {
  const s = state();
  let map = s.serials.get(owner);
  if (!map) s.serials.set(owner, (map = new Map()));
  map.set(serial, agentId);
}
export function agentForSerial(owner: string, serial: string): string | undefined {
  return state().serials.get(owner)?.get(serial);
}

const parseJson = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** Ask every connected computer for its phones and merge the lists, tagging each phone with its computer. */
export async function listDevices(
  owner: string,
  timeoutMs = 60_000,
): Promise<{
  devices: ComputerDevice[];
  computers: { id: string; name: string; ok: boolean; count: number }[];
}> {
  const agents = onlineAgents(owner);
  if (!agents.length)
    throw new RelayError(
      'คอมที่ต่อโทรศัพท์ยังไม่เชื่อมต่อ ตรวจว่าเปิดเครื่องอยู่และตัวเชื่อม Boxphone ทำงานอยู่',
    );
  const settled = await Promise.allSettled(
    agents.map((a) =>
      submitJob(a.id, { action: 'devices', method: 'POST', owner, body: '{}' }, timeoutMs),
    ),
  );
  const devices: ComputerDevice[] = [];
  const computers: { id: string; name: string; ok: boolean; count: number }[] = [];
  let firstError: unknown;
  settled.forEach((result, index) => {
    const agent = agents[index];
    if (result.status === 'rejected') {
      firstError ??= result.reason;
      computers.push({ id: agent.id, name: agent.name, ok: false, count: 0 });
      return;
    }
    const list =
      result.value.status >= 200 && result.value.status < 300
        ? parseJson(result.value.body).devices
        : null;
    if (!Array.isArray(list)) {
      firstError ??= new RelayError(
        String(parseJson(result.value.body).error || 'อ่านรายชื่อเครื่องไม่สำเร็จ'),
        502,
      );
      computers.push({ id: agent.id, name: agent.name, ok: false, count: 0 });
      return;
    }
    let count = 0;
    for (const item of list as ComputerDevice[]) {
      if (!item || typeof item.serial !== 'string') continue;
      devices.push({ ...item, computerId: agent.id, computerName: agent.name });
      remember(owner, item.serial, agent.id);
      count += 1;
    }
    computers.push({ id: agent.id, name: agent.name, ok: true, count });
  });
  if (!computers.some((c) => c.ok))
    throw firstError instanceof Error ? firstError : new RelayError('อ่านรายชื่อเครื่องไม่สำเร็จ');
  devices.sort(
    (a, b) =>
      Number(a.xiaoweiNumber ?? Infinity) - Number(b.xiaoweiNumber ?? Infinity) ||
      a.serial.localeCompare(b.serial),
  );
  return { devices, computers };
}

/** Send a phone action to the computer that holds that phone. */
export async function submitForSerial(
  owner: string,
  serial: string,
  job: Omit<RelayJob, 'id' | 'owner'>,
  timeoutMs = 125_000,
): Promise<RelayResult> {
  let agentId = agentForSerial(owner, serial);
  if (!agentId) {
    await listDevices(owner); // the map may simply be cold after a restart
    agentId = agentForSerial(owner, serial);
  }
  if (!agentId)
    throw new RelayError('ไม่พบโทรศัพท์เครื่องนี้ในคอมที่เชื่อมต่ออยู่ ลองค้นหาเครื่องใหม่', 404);
  return submitJob(agentId, { ...job, owner }, timeoutMs);
}

/** Test helper: forget everything. */
export function resetRelay(): void {
  const s = state();
  for (const a of s.agents.values()) for (const w of a.waiters) clearTimeout(w.timer);
  for (const p of s.open.values()) clearTimeout(p.timer);
  holder.__boxphoneRelay2 = undefined;
}
