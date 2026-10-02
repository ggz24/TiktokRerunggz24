'use client';

import { useEffect, useRef, useState } from 'react';
import { apiPath } from '@/lib/base-path';

type Settings = {
  enabled: boolean;
  knowledge: string;
  instructions: string;
  cooldownSeconds: number;
  maxPerMinute: number;
  productName: string;
  answerWhen: 'all' | 'questions';
  model: string;
  minWords: number;
  maxWords: number;
  strict: boolean;
  bannedWords: string;
};
type Entry = {
  id: string;
  comment: string;
  reply: string | null;
  status: string;
  reason: string | null;
  preview: boolean;
};
type State = {
  settings: Settings;
  history: Entry[];
  hasApiKey: boolean;
  aiReady: boolean;
  chatReady: boolean;
  connection?: { mode: string; connected: boolean; message: string; hasCapture?: boolean };
};

const modelChoices = [
  ['gpt-4.1-mini', 'GPT-4.1 mini · สมดุลสำหรับแชท'],
  ['gpt-4.1-nano', 'GPT-4.1 nano · งานตอบสั้น'],
  ['gpt-4o-mini', 'GPT-4o mini · รุ่นเล็ก'],
  ['gpt-5-mini', 'GPT-5 mini'],
  ['gpt-5-nano', 'GPT-5 nano'],
  ['gpt-5.4-mini', 'GPT-5.4 mini'],
  ['gpt-5.4-nano', 'GPT-5.4 nano'],
  ['gpt-4.1', 'GPT-4.1'],
  ['gpt-4o', 'GPT-4o'],
  ['gpt-5', 'GPT-5'],
];

export default function AiCommentReplyPanel({ accountId }: { accountId?: string }) {
  const [accounts, setAccounts] = useState<{ id: string; alias?: string; username?: string }[]>([]);
  const [selected, setSelected] = useState(accountId ?? '');
  const [error, setError] = useState('');
  useEffect(() => {
    if (accountId) return;
    let active = true;
    fetch(apiPath('/api/accounts'))
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const data = await r.json();
        if (active) {
          setAccounts(data.items ?? []);
          setSelected(data.items?.[0]?.id ?? '');
        }
      })
      .catch(() => {
        if (active) setError('โหลดบัญชีไม่สำเร็จ');
      });
    return () => {
      active = false;
    };
  }, [accountId]);
  return (
    <div className="cyber-account-form ai-reply-panel">
      {!accountId && (
        <section className="ai-settings-card">
          <div className="ai-section-heading">
            <span aria-hidden="true">▪</span>
            <h3>เลือกบัญชีสำหรับตอบแชท</h3>
          </div>
          <label className="ai-account-picker">
            บัญชี TikTok
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">เลือกบัญชี</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.alias || a.username || a.id}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {selected ? (
        <AccountAiSettings key={selected} accountId={selected} />
      ) : (
        <p>เพิ่มบัญชีเพื่อเริ่มตั้งค่า AI</p>
      )}
    </div>
  );
}

function AccountAiSettings({ accountId }: { accountId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [chatCapture, setChatCapture] = useState('');
  const captureEdited = useRef(false);
  const [models, setModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/ai-comments/${accountId}`;
  async function request(action: string, method = 'GET', body?: unknown) {
    const r = await fetch(apiPath(endpoint + action), {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'ดำเนินการไม่สำเร็จ');
    return data;
  }
  useEffect(() => {
    let active = true;
    void fetch(apiPath(endpoint + '/chat-session'), { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('โหลด session แชทไม่สำเร็จ');
        const data = await r.json();
        if (active && !captureEdited.current) setChatCapture(data.capture ?? '');
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    fetch(apiPath(endpoint))
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'โหลดการตั้งค่าไม่สำเร็จ');
        if (active) {
          setState(data);
          setSettings(data.settings);
        }
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    const timer = setInterval(() => {
      void fetch(apiPath(endpoint))
        .then(async (r) => {
          if (r.ok) {
            const data = await r.json();
            if (active) setState(data);
          }
        })
        .catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [endpoint]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }
  function field<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
  }
  if (!settings || !state) return <p role="status">{message || 'กำลังโหลดการตั้งค่า AI…'}</p>;
  const counts = state.history.filter((e) => !e.preview);
  return (
    <div className="ai-reply-settings">
      <header className="ai-reply-hero">
        <div>
          <h3>AI ช่วยตอบแชท TikTok LIVE</h3>
          <p>กำหนดข้อมูลสินค้าและแนวทางตอบ แล้วทดลองก่อนใช้งาน</p>
        </div>
        <span className={`ai-status ${state.aiReady ? 'ready' : ''}`}>
          {state.aiReady ? 'เชื่อม AI แล้ว' : 'รอตั้งค่า AI'}
        </span>
      </header>
      <section className="ai-settings-card ai-card-wide">
        <div className="ai-section-heading">
          <span aria-hidden="true">▪</span>
          <h3>การตอบอัตโนมัติ</h3>
        </div>
        {!state.chatReady && (
          <p className="ai-connection-notice">
            {state.connection?.message || 'กำลังตรวจการเชื่อมแชทจากเซิร์ฟเวอร์'} —
            {settings.enabled
              ? 'เปิดโหมด AI ไว้แล้ว รอเชื่อมรับคอมเมนต์ จึงจะเริ่มตอบจริง'
              : 'เปิดโหมด AI และบันทึกไว้ได้ ระบบจะเริ่มตอบเมื่อเชื่อมรับคอมเมนต์สำเร็จ'}
          </p>
        )}
        {state.chatReady && (
          <p className="ai-connection-notice">
            เชื่อมแชทจากเซิร์ฟเวอร์แล้ว — เปิด AI ช่วยตอบแชทและบันทึกเพื่อเริ่มตอบ
          </p>
        )}
        <p>
          การส่งแชทและการรับคอมเมนต์เป็นคนละส่วน เปิดโหมดไว้ได้ก่อนเริ่มไลฟ์
          ระบบจะตอบจริงเมื่อทั้งสองส่วนเชื่อมต่อพร้อม หน้านี้ตรวจสถานะซ้ำให้อัตโนมัติ
        </p>
        <label>
          เชื่อมส่งแชทด้วย session ของบัญชี
          <textarea
            value={chatCapture}
            onChange={(e) => {
              captureEdited.current = true;
              setChatCapture(e.target.value);
            }}
            placeholder="วาง cURL ของ streamer_desktop/message/chat ที่ส่งสำเร็จ"
            rows={4}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p>
          {state.connection?.hasCapture
            ? 'บันทึก session ส่งแชทไว้แล้ว'
            : 'ยังไม่มี session ส่งแชท'}{' '}
          — เก็บแบบเข้ารหัส และแสดง cURL ที่บันทึกไว้ในช่องนี้เฉพาะเจ้าของบัญชี ระบบใช้ห้อง LIVE
          ล่าสุดของบัญชี หาก session หมดอายุหรือส่งไม่ได้ ให้อัปเดต cURL ไม่ต้องติดตั้ง Extension
          หรือเปิด Chrome ค้างไว้
        </p>
        <button
          className="cyber-btn"
          type="button"
          disabled={busy || !chatCapture.trim()}
          onClick={() =>
            void run(async () => {
              await request('/chat-session', 'POST', { capture: chatCapture });
              captureEdited.current = true;
              setState(await request(''));
              setMessage('บันทึก session แชทแล้ว');
            })
          }
        >
          บันทึก session แชท
        </button>
        {state.connection?.hasCapture && (
          <button
            className="cyber-btn"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await request('/chat-session', 'POST', { remove: true });
                captureEdited.current = true;
                setChatCapture('');
                setState(await request(''));
                setMessage('ยกเลิก session แชทแล้ว');
              })
            }
          >
            ยกเลิกการเชื่อมแชท
          </button>
        )}
        <button
          className="cyber-btn"
          type="button"
          disabled={busy}
          onClick={() => void run(async () => setState(await request('')))}
        >
          ตรวจการเชื่อมต่อแชท
        </button>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => field('enabled', e.target.checked)}
          />{' '}
          เปิด AI ช่วยตอบแชท
        </label>
        <label>
          ให้ AI ตอบเมื่อไร
          <select
            value={settings.answerWhen}
            onChange={(e) => field('answerWhen', e.target.value as Settings['answerWhen'])}
          >
            <option value="all">AI พิจารณาตอบทุกคอมเมนต์</option>
            <option value="questions">เฉพาะคำถามเกี่ยวกับสินค้า</option>
          </select>
        </label>
      </section>
      <section className="ai-settings-card">
        <div className="ai-section-heading">
          <span>01</span>
          <h3>การเชื่อมต่อ AI</h3>
        </div>
        <label>
          ผู้ให้บริการ
          <select value="openai" disabled>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label>
          API Key
          <input
            type="password"
            autoComplete="new-password"
            maxLength={512}
            value={apiKey}
            placeholder={
              state.hasApiKey
                ? 'ตั้งไว้แล้ว — เว้นว่างเพื่อใช้ key เดิม'
                : 'กรอก API key ของ OpenAI'
            }
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <p>Key บันทึกแบบเข้ารหัส แยกตามบัญชี และไม่แสดงกลับในหน้าเว็บ</p>
        <label>
          โมเดล
          <select
            value={customModel ? '__custom__' : settings.model}
            onChange={(e) => {
              setCustomModel(e.target.value === '__custom__');
              if (e.target.value !== '__custom__') field('model', e.target.value);
            }}
          >
            <optgroup label="โมเดลสำหรับตอบข้อความ">
              {modelChoices.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </optgroup>
            {models.filter((m) => !modelChoices.some(([id]) => id === m)).length > 0 && (
              <optgroup label="โมเดลเพิ่มเติมจาก API key">
                {models
                  .filter((m) => !modelChoices.some(([id]) => id === m))
                  .map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
              </optgroup>
            )}
            {!modelChoices.some(([id]) => id === settings.model) &&
              !models.includes(settings.model) && (
                <option value={settings.model}>{settings.model}</option>
              )}
            <option value="__custom__">กรอกชื่อโมเดลเอง…</option>
          </select>
        </label>
        {customModel && (
          <label>
            ชื่อโมเดล
            <input
              maxLength={80}
              value={settings.model}
              onChange={(e) => field('model', e.target.value)}
              placeholder="เช่น gpt-4.1-mini"
            />
          </label>
        )}
        <p>สิทธิ์ใช้แต่ละโมเดลขึ้นกับ API key กดดึงรายการเพื่อดูโมเดลเพิ่มเติมของคุณ</p>
        <button
          type="button"
          className="cyber-btn"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const data = await request('/models', 'POST', { apiKey });
              setModels(Array.from(new Set<string>(data.models)));
              setMessage('ดึงรายการโมเดลแล้ว');
            })
          }
        >
          ดึงรายการโมเดล
        </button>
        <details className="ai-advanced">
          <summary>รายละเอียดการเชื่อมต่อ</summary>
          <label>
            Base URL
            <input value="https://api.openai.com/v1" readOnly />
          </label>
        </details>
      </section>
      <section className="ai-settings-card">
        <div className="ai-section-heading">
          <span>02</span>
          <h3>ข้อมูลสินค้าและสไตล์ตอบ</h3>
        </div>
        <label>
          ชื่อสินค้า
          <input
            maxLength={300}
            value={settings.productName}
            onChange={(e) => field('productName', e.target.value)}
          />
        </label>
        <label>
          คำอธิบายสินค้า
          <textarea
            rows={5}
            maxLength={8000}
            value={settings.knowledge}
            onChange={(e) => field('knowledge', e.target.value)}
            placeholder="ข้อมูลสินค้า ราคา วิธีสั่งซื้อ และข้อจำกัดที่ตรวจสอบแล้ว"
          />
        </label>
        <label>
          คำสั่ง / สไตล์การขาย
          <textarea
            rows={3}
            maxLength={2000}
            value={settings.instructions}
            onChange={(e) => field('instructions', e.target.value)}
          />
        </label>
      </section>
      <section className="ai-settings-card">
        <div className="ai-section-heading">
          <span>03</span>
          <h3>ความยาวและความถี่</h3>
        </div>
        <div className="ai-reply-fields">
          <label>
            จำนวนคำขั้นต่ำ
            <input
              type="number"
              min={0}
              max={100}
              value={settings.minWords}
              onChange={(e) => field('minWords', Number(e.target.value))}
            />
          </label>
          <label>
            จำนวนคำสูงสุด
            <input
              type="number"
              min={1}
              max={100}
              value={settings.maxWords}
              onChange={(e) => field('maxWords', Number(e.target.value))}
            />
          </label>
          <label>
            พักระหว่างคำตอบ (วินาที)
            <input
              type="number"
              min={5}
              max={300}
              value={settings.cooldownSeconds}
              onChange={(e) => field('cooldownSeconds', Number(e.target.value))}
            />
          </label>
          <label>
            คำตอบสูงสุดต่อนาที
            <input
              type="number"
              min={1}
              max={10}
              value={settings.maxPerMinute}
              onChange={(e) => field('maxPerMinute', Number(e.target.value))}
            />
          </label>
        </div>
        <p>จำนวนคำเป็นแนวทางสำหรับ AI คำตอบที่เกิน 100 ตัวอักษรจะถูกข้าม</p>
      </section>
      <section className="ai-settings-card">
        <div className="ai-section-heading">
          <span>04</span>
          <h3>ขอบเขตการตอบ</h3>
        </div>
        <label>
          <input
            type="checkbox"
            checked={settings.strict}
            onChange={(e) => field('strict', e.target.checked)}
          />{' '}
          โหมดเข้มงวด — ตอบจากข้อมูลสินค้าที่ให้เท่านั้น
        </label>
        <label>
          คำต้องห้าม (คั่นด้วยจุลภาคหรือขึ้นบรรทัดใหม่)
          <textarea
            rows={3}
            maxLength={2000}
            value={settings.bannedWords}
            onChange={(e) => field('bannedWords', e.target.value)}
          />
        </label>
        <p>ข้ามคอมเมนต์และคำตอบที่มีคำต้องห้าม ไม่ส่งข้อความซ้ำจากคอมเมนต์เดิม</p>
      </section>
      <section className="ai-settings-card">
        <div className="ai-section-heading">
          <span>05</span>
          <h3>ทดลองบทสนทนา</h3>
        </div>
        <label>
          คำถามตัวอย่าง
          <input maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </label>
        <button
          type="button"
          className="cyber-btn"
          disabled={busy || !question.trim()}
          onClick={() =>
            void run(async () => {
              setResult('');
              const data = await request('/preview', 'POST', {
                comment: question,
                settings,
                apiKey,
              });
              setResult(data.item?.reply || data.item?.reason || 'ไม่มีคำตอบ');
              setState(await request(''));
            })
          }
        >
          ทดลองตอบ
        </button>
        <p>ใช้ข้อมูลในฟอร์มนี้เพื่อทดลอง ไม่ส่งเข้าไลฟ์จริง การทดลองใช้โควตาของผู้ให้บริการ</p>
        {result && (
          <p role="status" className="ai-preview-answer">
            {result}
          </p>
        )}
      </section>
      <section className="ai-settings-card">
        <div className="ai-section-heading">
          <span>06</span>
          <h3>ประวัติการตอบ</h3>
        </div>
        <p>สถิติจาก 100 รายการล่าสุด ไม่รวมการทดลอง</p>
        <div className="ai-stats-grid">
          {[
            ['sent', 'ส่งแล้ว'],
            ['skipped', 'ข้าม'],
            ['failed', 'ไม่สำเร็จ'],
          ].map(([status, label]) => (
            <div key={status}>
              <strong>{counts.filter((e) => e.status === status).length}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="cyber-btn"
          disabled={busy}
          onClick={() => void run(async () => setState(await request('')))}
        >
          รีเฟรชประวัติ
        </button>
        {state.history.slice(0, 10).map((e) => (
          <div key={e.id} className="ai-reply-history">
            <strong>
              {e.preview ? 'ทดลอง' : 'ไลฟ์'} · {e.comment}
            </strong>
            <p>{e.reply || e.reason || 'กำลังประมวลผล'}</p>
          </div>
        ))}
        {!state.history.length && (
          <p className="ai-empty-history">ยังไม่มีบทสนทนา ลองถาม AI จากช่องทดลองตอบ</p>
        )}
      </section>
      <footer className="ai-save-bar">
        {message && (
          <p role="status" className="cyber-live-notice">
            {message}
          </p>
        )}
        <button
          type="button"
          className="cyber-btn primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await request('/settings', 'PATCH', { ...settings, apiKey });
              setApiKey('');
              setState(await request(''));
              setMessage('บันทึกการตั้งค่า AI แล้ว');
            })
          }
        >
          {busy ? 'กำลังดำเนินการ…' : 'บันทึกการตั้งค่า AI'}
        </button>
      </footer>
    </div>
  );
}
