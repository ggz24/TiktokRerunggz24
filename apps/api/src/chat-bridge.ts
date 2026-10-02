import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { CommentChatConnector, CommentReplyService } from './ai-comments.js';
import { CommentReplyError } from './ai-comments.js';
const require = createRequire(import.meta.url);
const { decodeLiveChatFrame } =
  require('@live-hub/tiktok-client') as typeof import('@live-hub/tiktok-client');

type Context = { roomId: string; handle: string; userId: string };
type Job = {
  id: string;
  text: string;
  roomId: string;
  issued: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (e: Error) => void;
};
type Session = Context & {
  owner: string;
  account: string;
  expires: number;
  started: number;
  lastSeen: number;
  active: boolean;
  clientId: string | null;
  lastPoll: number;
  frameWindow: number;
  frameCount: number;
  job?: Job;
  receiving: boolean;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = (owner: string, account: string) => `${owner}\0${account}`;
const unavailable = () =>
  new CommentReplyError(409, 'ส่วนเชื่อมแชทยังไม่พร้อมหรือห้อง LIVE เปลี่ยนแล้ว');

/** One API replica. Tokens are account/room scoped, revocable and expire after 12 hours. */
export class ChatBridge implements CommentChatConnector {
  private sessions = new Map<string, Session>();
  private accounts = new Map<string, string>();
  private replies?: CommentReplyService;
  constructor(
    private readonly context: (owner: string, account: string) => Promise<Context | null>,
    private readonly now = () => Date.now(),
    private readonly sendTimeout = 20000,
  ) {}
  attach(replies: CommentReplyService) {
    this.replies = replies;
  }
  private remove(key: string) {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.job) {
      clearTimeout(session.job.timer);
      session.job.reject(unavailable());
    }
    this.accounts.delete(scope(session.owner, session.account));
    this.sessions.delete(key);
  }
  revoke(owner: string, account: string) {
    const key = this.accounts.get(scope(owner, account));
    if (key) this.remove(key);
  }
  async pair(owner: string, account: string) {
    const context = await this.context(owner, account);
    if (!context || !/^\d{8,24}$/.test(context.roomId) || !context.handle || !context.userId)
      throw unavailable();
    for (const [key, session] of this.sessions) if (session.expires <= this.now()) this.remove(key);
    if (this.sessions.size >= 1000)
      throw new CommentReplyError(429, 'ส่วนเชื่อมมีจำนวนมาก กรุณารอ');
    this.revoke(owner, account);
    const token = randomBytes(32).toString('hex');
    const key = hash(token);
    const expires = this.now() + 12 * 60 * 60 * 1000;
    this.sessions.set(key, {
      ...context,
      owner,
      account,
      expires,
      started: this.now(),
      lastSeen: 0,
      active: false,
      clientId: null,
      lastPoll: 0,
      frameWindow: this.now(),
      frameCount: 0,
      receiving: false,
    });
    this.accounts.set(scope(owner, account), key);
    return {
      token,
      roomId: context.roomId,
      handle: context.handle,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  private session(token: string): Session {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new CommentReplyError(401, 'รหัสเชื่อมต่อไม่ถูกต้อง');
    const key = hash(token),
      session = this.sessions.get(key);
    if (!session || session.expires <= this.now()) {
      this.remove(key);
      throw new CommentReplyError(401, 'รหัสเชื่อมต่อหมดอายุ กรุณาจับคู่ใหม่');
    }
    return session;
  }
  private async current(session: Session) {
    const live = await this.context(session.owner, session.account);
    return (
      !!live &&
      live.roomId === session.roomId &&
      live.handle === session.handle &&
      live.userId === session.userId
    );
  }
  async ready(owner: string, account: string) {
    const session = this.sessions.get(this.accounts.get(scope(owner, account)) ?? '');
    return (
      !!session &&
      session.expires > this.now() &&
      session.active &&
      this.now() - session.lastSeen < 15000 &&
      (await this.current(session))
    );
  }
  async isCurrentRoom(owner: string, account: string, roomId: string) {
    const session = this.sessions.get(this.accounts.get(scope(owner, account)) ?? '');
    return !!session && session.roomId === roomId && (await this.ready(owner, account));
  }
  async status(owner: string, account: string) {
    const session = this.sessions.get(this.accounts.get(scope(owner, account)) ?? '');
    return {
      paired: !!session && session.expires > this.now(),
      connected: await this.ready(owner, account),
      expiresAt: session ? new Date(session.expires).toISOString() : null,
    };
  }
  async send(owner: string, account: string, roomId: string, text: string) {
    if (
      !(await this.isCurrentRoom(owner, account, roomId)) ||
      !text.trim() ||
      Array.from(text).length > 100
    )
      throw unavailable();
    const session = this.sessions.get(this.accounts.get(scope(owner, account))!)!;
    if (session.job) throw unavailable();
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (session.job?.id === id) session.job = undefined;
        reject(new CommentReplyError(503, 'ไม่ยืนยันผลส่งแชท จะไม่ส่งซ้ำอัตโนมัติ'));
      }, this.sendTimeout);
      timer.unref();
      session.job = { id, text, roomId, resolve, reject, timer, issued: false };
    });
  }
  async relay(token: string, body: unknown) {
    const session = this.session(token);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw unavailable();
    const b = body as Record<string, unknown>;
    if (
      Object.keys(b).some(
        (k) =>
          ![
            'action',
            'clientId',
            'roomId',
            'handle',
            'senderReady',
            'frame',
            'jobId',
            'accepted',
          ].includes(k),
      ) ||
      typeof b.clientId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(b.clientId)
    )
      throw unavailable();
    if (session.clientId && session.clientId !== b.clientId)
      throw new CommentReplyError(409, 'รหัสนี้ใช้อยู่ในอีกแท็บ กรุณาจับคู่ใหม่');
    if (
      b.roomId !== session.roomId ||
      b.handle !== session.handle ||
      !(await this.current(session))
    ) {
      session.active = false;
      throw unavailable();
    }
    session.clientId = b.clientId;
    if (b.action === 'poll') {
      if (this.now() - session.lastPoll < 500) throw new CommentReplyError(429, 'กรุณารอสักครู่');
      session.lastPoll = this.now();
      session.lastSeen = this.now();
      session.active = b.senderReady === true;
      if (session.active && session.job && !session.job.issued) {
        // Recheck AUTO after queuing; disabling it must cancel an undispatched reply.
        const state = await this.replies?.state(session.owner, session.account);
        if (!state?.settings.enabled) {
          const job = session.job;
          session.job = undefined;
          clearTimeout(job.timer);
          job.reject(unavailable());
        } else {
          session.job.issued = true;
          return { job: { id: session.job.id, text: session.job.text, roomId: session.roomId } };
        }
      }
      return { job: null };
    }
    if (b.action === 'ack') {
      if (typeof b.jobId !== 'string' || typeof b.accepted !== 'boolean') throw unavailable();
      const job = session.job;
      if (!job || job.id !== b.jobId || !job.issued) return { ok: true };
      session.job = undefined;
      clearTimeout(job.timer);
      if (b.accepted && session.active) job.resolve();
      else job.reject(unavailable());
      return { ok: true };
    }
    if (
      b.action !== 'frame' ||
      typeof b.frame !== 'string' ||
      b.frame.length > 1400000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(b.frame) ||
      !(await this.ready(session.owner, session.account))
    )
      throw unavailable();
    if (this.now() - session.frameWindow >= 60000) {
      session.frameWindow = this.now();
      session.frameCount = 0;
    }
    if (++session.frameCount > 600) throw new CommentReplyError(429, 'ข้อมูลแชทเข้ามาถี่เกินไป');
    let events;
    try {
      events = decodeLiveChatFrame(Buffer.from(b.frame, 'base64'), session.roomId);
    } catch {
      throw new CommentReplyError(400, 'เฟรมแชทไม่ถูกต้อง');
    }
    if (session.receiving || !this.replies) return { ok: true };
    const replies = this.replies;
    session.receiving = true;
    // Each batch is bounded; never replay history or the host's own responses.
    void (async () => {
      try {
        for (const event of events.slice(0, 20)) {
          if (
            event.senderId === session.userId ||
            !event.createdAt ||
            event.createdAt < session.started - 5000 ||
            this.now() - event.createdAt > 30000 ||
            event.createdAt > this.now() + 30000
          )
            continue;
          try {
            await replies.process(session.owner, session.account, event, false);
          } catch {
            /* Rate limits/readiness are intentional; never expose raw payloads. */
          }
        }
      } finally {
        session.receiving = false;
      }
    })();
    return { ok: true };
  }
  close() {
    for (const key of this.sessions.keys()) this.remove(key);
  }
}
