import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Pool } from 'pg';
import { TikTokLiveConnection } from 'tiktok-live-connector';
import { lookupTikTokIdentity } from './accounts.js';
import {
  CommentReplyError,
  type CommentChatConnector,
  type CommentReplyService,
} from './ai-comments.js';
const require = createRequire(import.meta.url);
const { parseLiveChatCurl, sendLiveChatWithSession } =
  require('@live-hub/tiktok-client') as typeof import('@live-hub/tiktok-client');
type Identity = { handle: string; userId: string };
export interface CommentReceiver {
  connect(): Promise<{ roomId: string }>;
  disconnect(): void;
  on(event: string, callback: (data: unknown) => void): unknown;
}
type ReceiverChat = {
  msgId?: string;
  createTime?: string | number;
  comment?: string;
  content?: string;
  common?: { msgId?: string; createTime?: string | number; roomId?: string };
  user?: { userId?: string; id?: string };
};
type Connection = {
  receiver: CommentReceiver;
  room: string | null;
  capture: string;
  busy: boolean;
  started: number;
  identity: Identity;
};
const scopeKey = (owner: string, account: string) => `${owner}\0${account}`;

export async function ensureSessionChatTables(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS livehub_chat_sessions (
    owner_id VARCHAR(128) NOT NULL, account_id UUID NOT NULL, secret JSONB NOT NULL,
    PRIMARY KEY(owner_id,account_id))`);
}

/** Anonymous receiver and authenticated direct Shop sender. Account Cookies stay at TikTok. */
export class SessionChat implements CommentChatConnector {
  private sessions = new Map<string, Connection>();
  private starting = new Set<string>();
  private retryAt = new Map<string, number>();
  private messages = new Map<string, string>();
  private replies?: CommentReplyService;
  private closed = false;
  constructor(
    private pool: Pool,
    private encryptionKey: Buffer,
    private account: (owner: string, account: string) => Promise<Identity | null>,
    private receiverFactory: (handle: string) => CommentReceiver = (handle) =>
      new TikTokLiveConnection(handle, {
        authenticateWs: false,
        processInitialData: false,
        fetchRoomInfoOnConnect: true,
        ...(process.env.EULER_STREAM_API_KEY
          ? { signApiKey: process.env.EULER_STREAM_API_KEY }
          : {}),
        // Deliberately no session/sessionId/cookie or authenticated proxy options.
      }) as unknown as CommentReceiver,
    private identify = lookupTikTokIdentity,
    private sendChat = sendLiveChatWithSession,
  ) {}
  attach(service: CommentReplyService) {
    this.replies = service;
  }
  private aad(owner: string, account: string) {
    return Buffer.from(`${owner}\0${account}\0chat-session`);
  }
  private async capture(owner: string, account: string): Promise<string | null> {
    const r = await this.pool.query(
      'SELECT secret FROM livehub_chat_sessions WHERE owner_id=$1 AND account_id=$2',
      [owner, account],
    );
    const s = r.rows[0]?.secret;
    if (!s) return null;
    const cipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(s.iv, 'base64'));
    cipher.setAAD(this.aad(owner, account));
    cipher.setAuthTag(Buffer.from(s.tag, 'base64'));
    return Buffer.concat([
      cipher.update(Buffer.from(s.ciphertext, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  }
  async savedCapture(owner: string, account: string) {
    if (!(await this.account(owner, account))) throw new CommentReplyError(404, 'ไม่พบบัญชี');
    return this.capture(owner, account);
  }
  async configure(owner: string, account: string, capture: string | null) {
    const identity = await this.account(owner, account);
    if (!identity) throw new CommentReplyError(409, 'ยืนยันบัญชี TikTok ก่อนตั้งค่าแชท');
    if (capture !== null) {
      let request;
      try {
        request = parseLiveChatCurl(capture);
      } catch {
        throw new CommentReplyError(400, 'cURL ส่งแชทไม่ถูกต้อง');
      }
      let holder;
      try {
        holder = await this.identify(request.cookieHeader, request.userAgent);
      } catch {
        /* fail closed */
      }
      if (
        !holder ||
        holder.userId !== identity.userId ||
        holder.username.toLowerCase() !== identity.handle.toLowerCase()
      )
        throw new CommentReplyError(
          409,
          'Cookie ใน cURL ไม่ตรงกับบัญชีที่เลือก หรือ session หมดอายุ',
        );
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      cipher.setAAD(this.aad(owner, account));
      const data = Buffer.concat([cipher.update(capture, 'utf8'), cipher.final()]);
      const secret = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: data.toString('base64'),
      };
      await this.pool.query(
        'INSERT INTO livehub_chat_sessions(owner_id,account_id,secret) VALUES($1,$2,$3) ON CONFLICT(owner_id,account_id) DO UPDATE SET secret=EXCLUDED.secret',
        [owner, account, JSON.stringify(secret)],
      );
    } else
      await this.pool.query(
        'DELETE FROM livehub_chat_sessions WHERE owner_id=$1 AND account_id=$2',
        [owner, account],
      );
    this.remove(scopeKey(owner, account));
    this.retryAt.delete(scopeKey(owner, account));
    this.messages.delete(scopeKey(owner, account));
  }
  private remove(scope: string) {
    const old = this.sessions.get(scope);
    this.sessions.delete(scope);
    old?.receiver.disconnect();
  }
  private async ensure(owner: string, account: string) {
    const scope = scopeKey(owner, account);
    if (
      this.closed ||
      this.sessions.has(scope) ||
      this.starting.has(scope) ||
      (this.retryAt.get(scope) || 0) > Date.now()
    )
      return;
    this.starting.add(scope);
    try {
      const [capture, identity] = await Promise.all([
        this.capture(owner, account),
        this.account(owner, account),
      ]);
      if (!capture || !identity) {
        this.messages.set(scope, 'บันทึก cURL ส่งแชทของบัญชีนี้ก่อน แล้วเริ่ม LIVE');
        return;
      }
      parseLiveChatCurl(capture);
      const receiver = this.receiverFactory(identity.handle);
      const connection: Connection = {
        receiver,
        room: null,
        capture,
        busy: false,
        started: Date.now(),
        identity,
      };
      this.sessions.set(scope, connection);
      receiver.on('error', () => {
        if (this.sessions.get(scope) !== connection) return;
        connection.room = null;
        this.messages.set(scope, 'ตัวรับคอมเมนต์มีปัญหา กำลังรอเชื่อมใหม่');
        this.retryAt.set(scope, Date.now() + 60000);
        this.remove(scope);
      });
      const disconnected = () => {
        if (this.sessions.get(scope) !== connection) return;
        connection.room = null;
        this.sessions.delete(scope);
        this.retryAt.set(scope, Date.now() + 60000);
        this.messages.set(scope, 'LIVE ปิดหรือการเชื่อมต่อหลุด รอตรวจใหม่');
      };
      receiver.on('disconnected', disconnected);
      receiver.on('streamEnd', () => {
        disconnected();
        receiver.disconnect();
      });
      receiver.on('chat', (data) => {
        void this.receive(owner, account, connection, data);
      });
      this.messages.set(scope, 'กำลังเชื่อมรับคอมเมนต์จากเซิร์ฟเวอร์');
      const state = await receiver.connect();
      if (this.closed || this.sessions.get(scope) !== connection) {
        receiver.disconnect();
        return;
      }
      if (!/^\d{8,24}$/.test(String(state.roomId))) {
        this.remove(scope);
        this.messages.set(scope, 'ยังยืนยันห้อง LIVE ของบัญชีนี้ไม่ได้');
        this.retryAt.set(scope, Date.now() + 60000);
        return;
      }
      connection.room = String(state.roomId);
      this.messages.set(scope, 'เชื่อมรับคอมเมนต์และส่งแชทด้วย session พร้อมแล้ว');
    } catch (error) {
      this.remove(scope);
      this.retryAt.set(scope, Date.now() + 60000);
      const name = error instanceof Error ? `${error.name} ${error.message}` : '';
      this.messages.set(
        scope,
        /offline|isn't online|not online/i.test(name)
          ? 'บัญชียังไม่ LIVE เริ่มไลฟ์ก่อน ระบบจะตรวจใหม่อัตโนมัติ'
          : /sign|rate|api.*key/i.test(name)
            ? 'บริการเชื่อมรับคอมเมนต์ต้องการ API key หรือถึงขีดจำกัด กรุณาตั้งค่า EULER_STREAM_API_KEY บนเซิร์ฟเวอร์'
            : 'ยังเชื่อมรับคอมเมนต์ไม่ได้ ตรวจการเข้าถึง TikTok และบริการรับคอมเมนต์',
      );
    } finally {
      this.starting.delete(scope);
    }
  }
  async ready(owner: string, account: string) {
    void this.ensure(owner, account).catch(() => {});
    return !!this.sessions.get(scopeKey(owner, account))?.room;
  }
  async connectionStatus(owner: string, account: string) {
    const connected = await this.ready(owner, account);
    return {
      mode: 'session',
      connected,
      hasCapture: !!(await this.capture(owner, account)),
      message: this.messages.get(scopeKey(owner, account)) || 'รอตั้งค่าการเชื่อมแชท',
    };
  }
  async isCurrentRoom(owner: string, account: string, room: string) {
    const connection = this.sessions.get(scopeKey(owner, account));
    const identity = await this.account(owner, account);
    return (
      !!room &&
      connection?.room === room &&
      !!identity &&
      connection.identity.userId === identity.userId &&
      connection.identity.handle === identity.handle
    );
  }
  async send(owner: string, account: string, room: string, text: string) {
    const connection = this.sessions.get(scopeKey(owner, account));
    if (!connection || !(await this.isCurrentRoom(owner, account, room)))
      throw new CommentReplyError(409, 'ห้องแชทไม่พร้อม');
    const result = await this.sendChat(connection.capture, {
      content: text,
      roomId: room,
      currentRoom: async () => ((await this.isCurrentRoom(owner, account, room)) ? room : null),
    });
    if (result.status !== 'accepted') {
      this.remove(scopeKey(owner, account));
      this.messages.set(scopeKey(owner, account), 'ส่งแชทไม่สำเร็จ กรุณาอัปเดต session/cURL');
      this.retryAt.set(scopeKey(owner, account), Date.now() + 60000);
      throw new CommentReplyError(503, 'ส่งแชทไม่สำเร็จ จะไม่ส่งซ้ำอัตโนมัติ');
    }
  }
  private async receive(owner: string, account: string, connection: Connection, input: unknown) {
    if (
      !this.replies ||
      connection.busy ||
      !connection.room ||
      this.sessions.get(scopeKey(owner, account)) !== connection
    )
      return;
    if (!input || typeof input !== 'object') return;
    const data = input as ReceiverChat;
    const id = String(data.msgId || data.common?.msgId || '');
    const sender = String(data.user?.id || data.user?.userId || '');
    const comment = data.content ?? data.comment;
    const rawTime = Number(data.createTime || data.common?.createTime || 0);
    const time = rawTime > 1e12 ? rawTime : rawTime * 1000;
    if (
      !/^\d{8,24}$/.test(id) ||
      !sender ||
      sender === connection.identity.userId ||
      (data.common?.roomId && String(data.common.roomId) !== connection.room) ||
      typeof comment !== 'string' ||
      (time && (time < connection.started - 5000 || Math.abs(Date.now() - time) > 30000))
    )
      return;
    connection.busy = true;
    try {
      await this.replies.process(
        owner,
        account,
        { eventId: id, roomId: connection.room, comment },
        false,
      );
    } catch {
      /* Service records send failures; skipped events must never be retried. */
    } finally {
      connection.busy = false;
    }
  }
  async close() {
    this.closed = true;
    for (const scope of this.sessions.keys()) this.remove(scope);
  }
}
