export type AccountStatus = {
  accountId: string;
  hasOpenRoom: boolean;
  cart: {
    state: 'added' | 'removed' | 'rejected' | 'unverified';
    setName: string;
    productCount: number;
    source: 'manual' | 'live-start' | 'round';
    at: string | null;
  } | null;
  autoSet: { name: string; productCount: number } | null;
  ai: {
    enabled: boolean;
    aiReady: boolean;
    chatConnected: boolean;
    chatMessage: string;
    model: string;
    answerWhen: 'all' | 'questions';
    sentCount: number;
    lastReply: { status: string; at: string | null } | null;
  } | null;
  auto: {
    phase: 'idle' | 'live' | 'resting';
    phaseStartedAt: string | null;
    completedRounds: number;
    lastError: string | null;
    endAfterMinutes: number | null;
    restartAfterMinutes: number | null;
    dailyStartTime: string | null;
    recoverStream: boolean;
    autoAddProducts: boolean;
    autoPinProduct: boolean;
    videoCount: number;
    setCount: number;
  } | null;
};

type Tone = 'green' | 'yellow' | 'pink' | 'dim';

const sources = {
  manual: 'เพิ่มเอง',
  'live-start': 'เพิ่มตอนเริ่มไลฟ์',
  round: 'เพิ่มโดยรอบอัตโนมัติ',
};

function clock(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function duration(minutes: number) {
  return minutes % 60 === 0 && minutes >= 60 ? `${minutes / 60} ชม.` : `${minutes} นาที`;
}

function cartLine(status: AccountStatus): { tone: Tone; label: string; detail: string } {
  const { cart, autoSet } = status;
  const plan = autoSet
    ? `ตั้งไว้เพิ่มชุด “${autoSet.name}” (${autoSet.productCount} รายการ) อัตโนมัติตอนเริ่มไลฟ์`
    : 'ยังไม่ได้เปิดเพิ่มตะกร้าอัตโนมัติ';
  if (!status.hasOpenRoom) return { tone: 'dim', label: 'ยังไม่ได้ LIVE', detail: plan };
  if (!cart)
    return {
      tone: 'yellow',
      label: 'ยังไม่มีบันทึกการเพิ่มสินค้าในห้องนี้',
      detail: 'กด “เพิ่มสินค้า” เพื่อส่งชุดสินค้าเข้าตะกร้า',
    };
  const set = `ชุด “${cart.setName}” ${cart.productCount} รายการ`;
  const when = `${sources[cart.source]} ${clock(cart.at)}`.trim();
  if (cart.state === 'added')
    return { tone: 'green', label: 'มีสินค้าในตะกร้า', detail: `${set} · ${when}` };
  if (cart.state === 'removed')
    return {
      tone: 'yellow',
      label: 'ลบสินค้าออกจากตะกร้าแล้ว',
      detail: `${set} · ${clock(cart.at)}`,
    };
  if (cart.state === 'rejected')
    return {
      tone: 'pink',
      label: 'TikTok ปฏิเสธการเพิ่มสินค้า',
      detail: `${set} · cURL ของชุดอาจหมดอายุ ให้คัดลอกใหม่`,
    };
  return {
    tone: 'yellow',
    label: 'ส่งแล้วแต่ยืนยันผลไม่ได้',
    detail: `${set} · ตรวจตะกร้าใน TikTok Shop`,
  };
}

function aiLine(ai: AccountStatus['ai']): { tone: Tone; label: string; detail: string } {
  if (!ai) return { tone: 'dim', label: 'ตรวจสถานะไม่ได้', detail: '' };
  if (!ai.enabled) return { tone: 'dim', label: 'ปิดอยู่', detail: 'เปิดได้ที่เมนู AI ช่วยตอบ' };
  if (!ai.aiReady)
    return {
      tone: 'pink',
      label: 'เปิดอยู่ แต่ยังไม่มี API key',
      detail: 'ตั้งค่า API key ในเมนู AI ช่วยตอบ',
    };
  const mode = ai.answerWhen === 'questions' ? 'ตอบเฉพาะคำถาม' : 'ตอบทุกคอมเมนต์';
  const sent = ai.sentCount ? `ตอบแล้ว ${ai.sentCount} ครั้ง` : 'ยังไม่ได้ตอบ';
  const chat = ai.chatConnected
    ? 'เชื่อมแชทแล้ว'
    : ai.chatMessage || 'ยังไม่ได้เชื่อมแชท (ตอบไม่ได้)';
  return {
    tone: ai.chatConnected ? 'green' : 'yellow',
    label: ai.chatConnected ? 'เปิดและพร้อมตอบ' : 'เปิดอยู่ แต่แชทยังไม่เชื่อม',
    detail: `${mode} · ${chat} · ${sent}${ai.model ? ` · ${ai.model}` : ''}`,
  };
}

function autoLine(auto: AccountStatus['auto']): { tone: Tone; label: string; detail: string } {
  if (!auto) return { tone: 'dim', label: 'ตรวจสถานะไม่ได้', detail: '' };
  const plan = [
    auto.dailyStartTime ? `ขึ้นไลฟ์ทุกวัน ${auto.dailyStartTime} น.` : '',
    auto.endAfterMinutes ? `ลงไลฟ์หลัง ${duration(auto.endAfterMinutes)}` : '',
    auto.restartAfterMinutes ? `พัก ${duration(auto.restartAfterMinutes)} แล้วขึ้นใหม่` : '',
    auto.recoverStream ? 'กู้สัญญาณเมื่อหลุด' : '',
    auto.videoCount > 1 ? `วนคลิป ${auto.videoCount} คลิป` : '',
    auto.autoAddProducts ? 'เพิ่มสินค้าก่อนเริ่มรอบ' : '',
    auto.autoPinProduct ? 'ปักหมุดสินค้า' : '',
  ].filter(Boolean);
  const timed = Boolean(
    auto.dailyStartTime || auto.endAfterMinutes || auto.restartAfterMinutes || auto.recoverStream,
  );
  const detail = plan.length ? plan.join(' · ') : 'ยังไม่ได้ตั้งเวลา';
  if (auto.lastError)
    return { tone: 'pink', label: 'ล่าสุดทำงานไม่สำเร็จ', detail: `${auto.lastError} · ${detail}` };
  if (!timed)
    return {
      tone: 'dim',
      label: 'ยังไม่ได้ตั้ง',
      detail: 'ตั้งได้ที่ปุ่ม “ตั้งค่าไลฟ์” แท็บ AUTO',
    };
  if (auto.phase === 'live')
    return {
      tone: 'green',
      label: `ทำงาน · กำลังออกอากาศรอบที่ ${auto.completedRounds + 1}${auto.phaseStartedAt ? ` (เริ่ม ${clock(auto.phaseStartedAt)} น.)` : ''}`,
      detail,
    };
  if (auto.phase === 'resting')
    return { tone: 'yellow', label: 'ทำงาน · พักก่อนขึ้นรอบถัดไป', detail };
  return { tone: 'green', label: 'ทำงาน · รอเวลาขึ้นไลฟ์', detail };
}

export default function AccountStatusPanel({
  status,
  loaded,
}: {
  status: AccountStatus | undefined;
  loaded: boolean;
}) {
  if (!loaded || !status)
    return (
      <div className="cyber-status-panel" aria-live="polite">
        <p className="cyber-account-note">{loaded ? 'ตรวจสถานะบัญชีไม่ได้' : 'กำลังตรวจสถานะ…'}</p>
      </div>
    );
  const rows = [
    { key: 'cart', title: '🛒 ตะกร้าสินค้า', ...cartLine(status) },
    { key: 'ai', title: '🤖 AI ช่วยตอบ', ...aiLine(status.ai) },
    { key: 'auto', title: '⏱ ขึ้น/ลงไลฟ์อัตโนมัติ', ...autoLine(status.auto) },
  ];
  return (
    <div className="cyber-status-panel" aria-live="polite">
      {rows.map((row) => (
        <div className={`cyber-status-row tone-${row.tone}`} key={row.key}>
          <span className="cyber-status-title">{row.title}</span>
          <strong>{row.label}</strong>
          {row.detail && <small>{row.detail}</small>}
        </div>
      ))}
      <p className="cyber-account-note">
        สถานะตะกร้าอ้างอิงจากคำสั่งที่ Live Hub ส่งในห้องนี้ (TikTok ไม่เปิดให้อ่านตะกร้าจริง)
      </p>
    </div>
  );
}
