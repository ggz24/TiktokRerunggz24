import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  CommentReplyError,
  type CommentChatConnector,
  type CommentReplyService,
} from './ai-comments.js';
const require = createRequire(import.meta.url);
const { decodeLiveChatFrame, inspectLiveChatResponse } =
  require('@live-hub/tiktok-client') as typeof import('@live-hub/tiktok-client');
export type ServerChatAccount = {
  /** Room started from this app, or null to follow whichever LIVE the account is running. */
  roomId: string | null;
  handle: string;
  userId: string;
  cookie: string;
  userAgent?: string;
};
type Connection = {
  managedRoom: string | null;
  roomId: string | null;
  userId: string;
  fingerprint: string;
  context: BrowserContext;
  page: Page;
  socketOpen: boolean;
  socketRoom: string | null;
  shopRoom?: string;
  receiving: boolean;
  started: number;
  touched: number;
  sending: boolean;
};
const key = (owner: string, account: string) => `${owner}\0${account}`;
const unavailable = () =>
  new CommentReplyError(409, 'แชท TikTok ยังไม่พร้อม ตรวจ session ของบัญชีและห้อง LIVE');

/** Only the saved account's isolated server browser prepares signed chat requests. */
export class ServerChat implements CommentChatConnector {
  private browser?: Promise<Browser>;
  private sessions = new Map<string, Connection>();
  private starting = new Map<string, Promise<void>>();
  private retryAt = new Map<string, number>();
  private reasons = new Map<string, string>();
  private replies?: CommentReplyService;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly account: (owner: string, account: string) => Promise<ServerChatAccount | null>,
    private readonly executablePath = process.env.CHAT_CHROMIUM_PATH || '/usr/bin/chromium',
    private readonly launch: typeof chromium.launch = chromium.launch.bind(chromium),
  ) {
    this.timer = setInterval(() => void this.maintain(), 10000);
    this.timer.unref();
  }
  attach(replies: CommentReplyService) {
    this.replies = replies;
  }
  private async maintain() {
    for (const [scope, session] of this.sessions) {
      const [owner, account] = scope.split('\0');
      try {
        const current = await this.account(owner, account);
        if (
          !current ||
          current.roomId !== session.managedRoom ||
          (!session.socketOpen &&
            Date.now() - session.started > (session.managedRoom ? 60000 : 120000))
        )
          await this.remove(scope);
      } catch {
        await this.remove(scope);
      }
    }
  }
  private async remove(scope: string) {
    const session = this.sessions.get(scope);
    this.sessions.delete(scope);
    await session?.context.close().catch(() => {});
  }
  private async ensure(owner: string, account: string) {
    if (this.closed) return;
    const scope = key(owner, account);
    const current = await this.account(owner, account);
    if (!current) {
      this.reasons.set(scope, 'บัญชียังไม่เชื่อมต่อหรือ session ใช้ไม่ได้ ตรวจที่การ์ดบัญชี');
      await this.remove(scope);
      return;
    }
    const fingerprint = createHash('sha256').update(current.cookie).digest('hex');
    const existing = this.sessions.get(scope);
    if (
      existing &&
      existing.managedRoom === current.roomId &&
      existing.fingerprint === fingerprint &&
      !existing.page.isClosed()
    ) {
      existing.touched = Date.now();
      return;
    }
    if (this.starting.has(scope) || (this.retryAt.get(scope) ?? 0) > Date.now()) return;
    const task = this.open(scope, current, fingerprint)
      .catch(() => {
        this.reasons.set(
          scope,
          'เชื่อม TikTok ไม่สำเร็จ: ตรวจ session หรือการเข้าถึง TikTok จากเซิร์ฟเวอร์',
        );
        this.retryAt.set(scope, Date.now() + 60000);
      })
      .finally(() => this.starting.delete(scope));
    this.starting.set(scope, task);
    // Opening can take a while. State polling must not wait for browser navigation.
    void task;
  }
  private async open(scope: string, current: ServerChatAccount, fingerprint: string) {
    await this.remove(scope);
    this.reasons.set(scope, 'กำลังเชื่อมแชทจากเซิร์ฟเวอร์…');
    if (!this.browser) {
      this.browser = this.launch({
        executablePath: this.executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        timeout: 20000,
      });
      this.browser
        .then((browser) =>
          browser.on('disconnected', () => {
            this.browser = undefined;
            this.sessions.clear();
          }),
        )
        .catch(() => {
          this.browser = undefined;
        });
    }
    const browser = await this.browser;
    if (this.closed) return;
    const context = await browser.newContext({
      ...(current.userAgent ? { userAgent: current.userAgent } : {}),
      locale: 'en-US',
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    try {
      // Cookie scope is limited to TikTok. No storage state or credentials are written to disk.
      const cookies = current.cookie
        .split(';')
        .map((part) => {
          const i = part.indexOf('=');
          return {
            name: part.slice(0, i).trim(),
            value: part.slice(i + 1).trim(),
            domain: '.tiktok.com',
            path: '/',
            secure: true,
            httpOnly: true,
          };
        })
        .filter((c) => c.name && /^[^\s=;]+$/.test(c.name));
      if (!cookies.length) throw unavailable();
      await context.addCookies(cookies);
      await context.route('**/*', (route) =>
        ['image', 'media', 'font'].includes(route.request().resourceType())
          ? route.abort()
          : route.continue(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const session: Connection = {
        managedRoom: current.roomId,
        roomId: current.roomId,
        userId: current.userId,
        fingerprint,
        context,
        page,
        socketOpen: false,
        socketRoom: null,
        receiving: false,
        started: Date.now(),
        touched: Date.now(),
        sending: false,
      };
      this.sessions.set(scope, session);
      page.on('response', async (response) => {
        try {
          const url = new URL(response.url());
          if (
            url.origin !== 'https://shop.tiktok.com' ||
            url.pathname !== '/api/v1/streamer_desktop/live_room_info/get'
          )
            return;
          const raw = await response.text();
          const data = JSON.parse(raw);
          const matches = [...raw.matchAll(/"room_id"\s*:\s*"?(\d+)"?/g)];
          if (data.code !== 0 || matches.length !== 1) return;
          session.shopRoom = matches[0][1];
          if (!session.managedRoom) {
            // Follow the LIVE this account is running now (TikTok LIVE Studio, phone or this app).
            if (
              /^\d{8,24}$/.test(session.shopRoom) &&
              (!session.socketRoom || session.socketRoom === session.shopRoom)
            )
              session.roomId = session.shopRoom;
            else if (!session.socketOpen)
              this.reasons.set(
                scope,
                'ยังไม่พบห้อง LIVE ของบัญชีนี้ใน TikTok Shop เริ่มไลฟ์ก่อน แล้วระบบจะเชื่อมแชทให้เอง',
              );
          } else if (session.shopRoom !== session.roomId)
            this.reasons.set(
              scope,
              'TikTok Shop ยังไม่พบห้อง LIVE ที่ตรงกับบัญชีนี้ ตรวจว่าขึ้นไลฟ์สำเร็จในบัญชีเดียวกัน',
            );
        } catch {
          /* Room identity must remain unverified on malformed responses. */
        }
      });
      page.on('websocket', (socket) => {
        let url: URL;
        try {
          url = new URL(socket.url());
        } catch {
          return;
        }
        const socketRoom = url.searchParams.get('room_id');
        if (
          url.hostname !== 'webcast-ws.tiktok.com' ||
          url.pathname !== '/webcast/im/ws_proxy/ws_reuse_supplement/' ||
          !socketRoom ||
          !/^\d{8,24}$/.test(socketRoom) ||
          (session.managedRoom
            ? socketRoom !== session.managedRoom
            : session.shopRoom !== undefined && socketRoom !== session.shopRoom)
        )
          return;
        if (!session.managedRoom) session.roomId = socketRoom;
        session.socketOpen = true;
        session.socketRoom = socketRoom;
        socket.on('close', () => {
          session.socketOpen = false;
        });
        socket.on('framereceived', ({ payload }) => {
          if (Buffer.isBuffer(payload)) void this.receive(scope, session, payload);
        });
      });
      page.on('close', () => {
        session.socketOpen = false;
      });
      await page.goto('https://shop.tiktok.com/streamer/live/product/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page
        .locator(
          'header,[role="banner"],[class*="header"],[class*="Header"],div[class~="h-60"][class~="fixed"]',
        )
        .getByText(current.handle, { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => {});
      // A login/challenge or wrong account must never enable sending.
      if (!(await this.identity(session, current.handle))) {
        this.reasons.set(
          scope,
          'session TikTok Shop ไม่พร้อมหรือยืนยันบัญชีไม่ได้ กรุณาอัปเดต session',
        );
        await this.remove(scope);
        this.retryAt.set(scope, Date.now() + 60000);
      } else if (!session.roomId || !session.shopRoom || session.shopRoom === session.roomId)
        this.reasons.set(
          scope,
          session.roomId
            ? 'รอการเชื่อมแชทของห้อง LIVE บน TikTok'
            : 'ยังไม่พบห้อง LIVE ของบัญชีนี้ใน TikTok Shop เริ่มไลฟ์ก่อน แล้วระบบจะเชื่อมแชทให้เอง',
        );
    } catch (e) {
      await context.close().catch(() => {});
      this.sessions.delete(scope);
      throw e;
    }
  }
  private input(session: Connection) {
    return session.page.locator(
      'textarea[placeholder="Type something..."],input[placeholder="Type something..."],textarea[placeholder="พิมพ์อะไรสักอย่าง..."],input[placeholder="พิมพ์อะไรสักอย่าง..."]',
    );
  }
  private async identity(session: Connection, handle: string) {
    return session.page
      .locator(
        'header,[role="banner"],[class*="header"],[class*="Header"],div[class~="h-60"][class~="fixed"]',
      )
      .getByText(handle, { exact: true })
      .count()
      .then((n) => n > 0)
      .catch(() => false);
  }
  async ready(owner: string, account: string) {
    await this.ensure(owner, account);
    const session = this.sessions.get(key(owner, account));
    const current = await this.account(owner, account);
    if (
      !session ||
      !current ||
      !session.roomId ||
      session.managedRoom !== current.roomId ||
      session.shopRoom !== session.roomId ||
      !session.socketOpen ||
      session.page.isClosed() ||
      !(await this.identity(session, current.handle))
    )
      return false;
    const input = this.input(session);
    return (
      (await input.count()) === 1 &&
      (await input.isVisible().catch(() => false)) &&
      (await input.isEnabled().catch(() => false))
    );
  }
  async connectionStatus(owner: string, account: string) {
    const connected = await this.ready(owner, account);
    return {
      mode: 'server',
      connected,
      message: connected
        ? 'เชื่อมแชทจากเซิร์ฟเวอร์แล้ว'
        : this.reasons.get(key(owner, account)) || 'รอแชทในห้อง LIVE',
    };
  }
  async isCurrentRoom(owner: string, account: string, roomId: string) {
    return (
      this.sessions.get(key(owner, account))?.roomId === roomId &&
      (await this.ready(owner, account))
    );
  }
  async send(owner: string, account: string, roomId: string, text: string) {
    if (
      !text.trim() ||
      Array.from(text).length > 100 ||
      !(await this.isCurrentRoom(owner, account, roomId))
    )
      throw unavailable();
    const session = this.sessions.get(key(owner, account))!;
    if (
      session.sending ||
      !this.replies ||
      !(await this.replies.state(owner, account)).settings.enabled
    )
      throw unavailable();
    session.sending = true;
    try {
      const input = this.input(session);
      if ((await input.inputValue()).trim()) throw unavailable();
      const response = session.page.waitForResponse(
        (r) => {
          try {
            const url = new URL(r.url());
            const body = r.request().postDataJSON();
            return (
              url.origin === 'https://shop.tiktok.com' &&
              url.pathname === '/api/v1/streamer_desktop/message/chat' &&
              r.request().method() === 'POST' &&
              body.content === text &&
              String(body.meta?.room_id) === roomId
            );
          } catch {
            return false;
          }
        },
        { timeout: 15000 },
      );
      // Attach catch immediately so an input error does not cause an unhandled rejection.
      void response.catch(() => {});
      await input.fill(text);
      await input.press('Enter');
      const result = await response;
      if (!result.ok() || inspectLiveChatResponse(await result.json()).status !== 'accepted')
        throw unavailable();
    } catch {
      throw new CommentReplyError(503, 'ไม่ยืนยันผลส่งแชท จะไม่ส่งซ้ำอัตโนมัติ');
    } finally {
      session.sending = false;
    }
  }
  private async receive(scope: string, session: Connection, frame: Buffer) {
    if (session.receiving || !this.replies || !session.socketOpen || !session.roomId) return;
    session.receiving = true;
    try {
      const [owner, account] = scope.split('\0');
      for (const event of decodeLiveChatFrame(frame, session.roomId).slice(0, 20)) {
        if (
          event.senderId === session.userId ||
          !event.createdAt ||
          event.createdAt < session.started - 5000 ||
          Date.now() - event.createdAt > 30000 ||
          event.createdAt > Date.now() + 30000
        )
          continue;
        await this.replies.process(owner, account, event, false).catch(() => {});
      }
    } catch {
      /* Malformed or stale frames never cause a send. */
    } finally {
      session.receiving = false;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.starting.values()]);
    for (const scope of this.sessions.keys()) await this.remove(scope);
    await (await this.browser?.catch(() => undefined))?.close();
  }
}
