'use client';

import { useEffect, useState } from 'react';
import { apiPath } from '@/lib/base-path';
import { confirmDialog } from '@/lib/confirm';

type Account = { id: string; alias: string; verifiedHandle?: string | null };
type Source = {
  id: string;
  name: string;
  host: string;
  path: string;
  method: 'GET' | 'POST';
  accountId: string | null;
  hasCookie: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
};
type Run = {
  ok: boolean;
  status: number;
  fetchedAt: string;
  data?: unknown;
  error?: string;
  hint?: string;
};

const METRICS: { keys: string[]; label: string }[] = [
  { keys: ['gmv', 'total_gmv', 'sales', 'revenue'], label: 'ยอดขาย (GMV)' },
  { keys: ['orders', 'order_count', 'sku_orders', 'paid_orders'], label: 'ออเดอร์' },
  { keys: ['items_sold', 'sold_items', 'units_sold'], label: 'จำนวนที่ขาย' },
  { keys: ['viewers', 'viewer_count', 'views', 'view_count', 'visitors'], label: 'ผู้ชม' },
  { keys: ['click_through_rate', 'ctr'], label: 'CTR' },
  { keys: ['customers', 'buyers'], label: 'ลูกค้า' },
];
const labels: Record<string, string> = Object.fromEntries(
  METRICS.flatMap((m) => m.keys.map((k) => [k, m.label])),
);

async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(apiPath('/api/stats-sources' + path), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : '';
    throw new Error(message || 'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง');
  }
  return data as Record<string, unknown>;
}

const isScalar = (v: unknown) => v === null || typeof v !== 'object';
/** Nearest value under one of the keys, searching breadth first. Only numbers and simple amounts count. */
function findMetric(root: unknown, keys: string[]): unknown {
  const queue: unknown[] = [root];
  for (let i = 0; i < queue.length && i < 3000; i += 1) {
    const node = queue[i];
    if (!node || typeof node !== 'object') continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (
        keys.includes(k.toLowerCase()) &&
        (isScalar(v) || (v && typeof v === 'object' && 'amount' in v)) &&
        v !== null
      )
        return v;
    }
    for (const v of Object.values(node as Record<string, unknown>))
      if (v && typeof v === 'object') queue.push(v);
  }
  return undefined;
}
function formatValue(key: string, value: unknown): string {
  const toNumber = (x: unknown) => {
    const n =
      typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  if (value && typeof value === 'object' && 'amount' in value) {
    const v = value as { amount?: unknown; currency?: unknown };
    const n = toNumber(v.amount);
    return `${n === null ? String(v.amount) : n.toLocaleString('th-TH')} ${String(v.currency ?? '')}`.trim();
  }
  const n = toNumber(value);
  if (n === null) return String(value);
  if (/^(ctr|click_through_rate)$/i.test(key))
    return `${(n <= 1 ? n * 100 : n).toLocaleString('th-TH', { maximumFractionDigits: 2 })}%`;
  return n.toLocaleString('th-TH');
}

function Tree({ value }: { value: unknown }) {
  if (Array.isArray(value))
    return (
      <div className="sales-tree">
        {value.slice(0, 50).map((v, i) => (
          <details key={i} open={i === 0}>
            <summary>รายการ {i + 1}</summary>
            <Tree value={v} />
          </details>
        ))}
        {value.length > 50 && <p className="sales-hint">แสดง 50 รายการแรกจาก {value.length}</p>}
      </div>
    );
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div className="sales-tree">
        <dl className="official-metrics">
          {entries
            .filter(([, v]) => isScalar(v))
            .map(([k, v]) => (
              <div key={k}>
                <dt>{labels[k.toLowerCase()] ?? k.replaceAll('_', ' ')}</dt>
                <dd>{v === null || v === undefined ? '—' : String(v)}</dd>
              </div>
            ))}
        </dl>
        {entries
          .filter(([, v]) => !isScalar(v))
          .map(([k, v]) => (
            <details key={k} open>
              <summary>{labels[k.toLowerCase()] ?? k.replaceAll('_', ' ')}</summary>
              <Tree value={v} />
            </details>
          ))}
      </div>
    );
  }
  return <p>{String(value)}</p>;
}

export default function SalesPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [curl, setCurl] = useState('');
  const [replacing, setReplacing] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    const data = await call('');
    setSources((data.items as Source[]) ?? []);
    setLoaded(true);
  }
  useEffect(() => {
    void load().catch((e) => {
      setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ');
      setLoaded(true);
    });
    void fetch(apiPath('/api/accounts'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setAccounts(Array.isArray(d.items) ? d.items : []))
      .catch(() => undefined);
  }, []);

  async function act(label: string, task: () => Promise<void>) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'เกิดข้อผิดพลาด');
    } finally {
      setBusy('');
    }
  }
  const run = (id: string) =>
    act('run:' + id, async () => {
      const result = (await call(`/${id}/run`, 'POST', {})) as unknown as Run;
      setRuns((current) => ({ ...current, [id]: result }));
      await load();
    });
  const accountName = (id: string | null) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.alias}${a.verifiedHandle ? ` (${a.verifiedHandle})` : ''}` : '';
  };

  return (
    <section className="cyber-panel">
      <h2 className="cyber-panel-head">▪ ยอดขายและสถิติ (ดึงด้วย session ของบัญชี)</h2>
      <div className="cyber-panel-body official-api-body">
        <p>
          ไม่ต้องสมัครหรือขอ API ใช้ session ที่เชื่อมไว้ดึงตัวเลขจากหน้าสถิติที่คุณเปิดดูอยู่ใน
          TikTok วางคำสั่ง cURL ของหน้านั้นครั้งเดียว แล้วกด &quot;ดึงข้อมูล&quot; เมื่อไหร่ก็ได้
        </p>
        <details>
          <summary>วิธีคัดลอก cURL (ทำครั้งเดียวต่อหน้า)</summary>
          <ol className="official-steps">
            <li>เปิดหน้าสถิติที่ต้องการใน Chrome (เช่นสรุปยอดของ LIVE) ด้วยบัญชีที่ล็อกอินอยู่</li>
            <li>
              กด F12 → แท็บ Network → โหลดหน้านั้นใหม่ → หาคำขอที่ตอบเป็นตัวเลขสถิติ (ตัวกรอง
              Fetch/XHR)
            </li>
            <li>
              คลิกขวาที่คำขอ → Copy → <strong>Copy as cURL (bash)</strong>
            </li>
            <li>วางที่ช่องด้านล่าง ตั้งชื่อ แล้วกดบันทึก</li>
          </ol>
          <p className="sales-hint">
            คำขอจะถูกส่งซ้ำตามเดิม (รวมช่วงวันที่ในนั้น) ถ้าขึ้นว่าหมดอายุ ให้คัดลอก cURL ใหม่แล้วกด
            &quot;วาง cURL ใหม่&quot; ข้อมูลที่ได้ไม่ใช่ API ทางการ ตัวเลขขึ้นอยู่กับหน้าที่คุณเลือก
          </p>
        </details>

        <div className="official-fields">
          <label>
            ชื่อ
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น ยอด LIVE วันนี้"
              maxLength={80}
            />
          </label>
          <label>
            บัญชีที่ใช้ session (ไม่เลือก = ใช้ cookie ใน cURL)
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">ใช้ cookie ใน cURL</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.alias}
                  {a.verifiedHandle ? ` (${a.verifiedHandle})` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {replacing ? 'cURL ใหม่ (แทนของเดิม)' : 'คำสั่ง cURL'}
          <textarea
            value={curl}
            onChange={(e) => setCurl(e.target.value)}
            placeholder="curl 'https://…tiktok.com/…' -H '…' -b '…'"
            rows={4}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="official-actions">
          <button
            className="cyber-btn pink"
            disabled={!!busy || !curl.trim() || (!replacing && !name.trim())}
            onClick={() =>
              void act('save', async () => {
                if (replacing) {
                  await call(`/${replacing}`, 'PATCH', { curl });
                  setNotice('แทน cURL แล้ว กดดึงข้อมูลได้เลย');
                } else {
                  await call('', 'POST', { name, curl, ...(accountId ? { accountId } : {}) });
                  setNotice('บันทึกแล้ว กดดึงข้อมูลได้เลย');
                  setName('');
                }
                setCurl('');
                setReplacing('');
                await load();
              })
            }
          >
            {replacing ? 'แทน cURL เดิม' : 'บันทึกแหล่งข้อมูล'}
          </button>
          {replacing && (
            <button
              className="cyber-btn"
              onClick={() => {
                setReplacing('');
                setCurl('');
              }}
            >
              ยกเลิก
            </button>
          )}
        </div>

        {loaded && sources.length === 0 && (
          <div className="sales-empty">
            <h3>ยังไม่มีแหล่งข้อมูล</h3>
            <p>เริ่มจากวาง cURL ของหน้าสถิติด้านบน ระบบจะแสดงตัวเลขสำคัญและข้อมูลทั้งหมดให้</p>
          </div>
        )}
        {sources.map((s) => {
          const r = runs[s.id];
          const cards = r?.ok
            ? METRICS.flatMap((m) => {
                const v = findMetric(r.data, m.keys);
                return v === undefined ? [] : [{ label: m.label, text: formatValue(m.keys[0], v) }];
              })
            : [];
          return (
            <div className="sales-source" key={s.id}>
              <div className="cyber-row">
                <div>
                  <strong>{s.name}</strong>
                  <p className="sales-hint">
                    {s.host}
                    {s.path} · {s.method}
                    {s.accountId
                      ? ` · ใช้ session ของ ${accountName(s.accountId) || 'บัญชีที่เลือก'}`
                      : s.hasCookie
                        ? ' · ใช้ cookie ใน cURL'
                        : ''}
                    {s.lastRunAt
                      ? ` · ดึงล่าสุด ${new Date(s.lastRunAt).toLocaleString('th-TH')} (${s.lastStatus})`
                      : ''}
                  </p>
                </div>
                <div className="official-actions">
                  <button
                    className="cyber-btn cyan"
                    disabled={!!busy}
                    onClick={() => void run(s.id)}
                  >
                    {busy === 'run:' + s.id ? 'กำลังดึง…' : 'ดึงข้อมูล'}
                  </button>
                  <button
                    className="cyber-btn"
                    disabled={!!busy}
                    onClick={() => {
                      setReplacing(s.id);
                      setCurl('');
                      setNotice(`วาง cURL ใหม่ของ "${s.name}" ในช่องด้านบน`);
                    }}
                  >
                    วาง cURL ใหม่
                  </button>
                  <button
                    className="cyber-btn danger"
                    disabled={!!busy}
                    onClick={() =>
                      void act('delete', async () => {
                        if (!(await confirmDialog(`ลบแหล่งข้อมูล "${s.name}" ใช่ไหม?`))) return;
                        await call(`/${s.id}`, 'DELETE');
                        setRuns((c) => {
                          const next = { ...c };
                          delete next[s.id];
                          return next;
                        });
                        await load();
                      })
                    }
                  >
                    ลบ
                  </button>
                </div>
              </div>
              {r && !r.ok && (
                <p className="cyber-account-error" role="alert">
                  {r.error}
                  {r.hint ? ` · ${r.hint}` : ''}
                </p>
              )}
              {r?.ok && (
                <>
                  <p className="sales-hint">
                    อ่านเมื่อ {new Date(r.fetchedAt).toLocaleString('th-TH')}
                  </p>
                  {cards.length > 0 ? (
                    <div className="sales-cards">
                      {cards.map((c) => (
                        <div className="sales-card" key={c.label}>
                          <small>{c.label}</small>
                          <strong>{c.text}</strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="sales-hint">ไม่พบตัวเลขสรุปที่รู้จัก ดูข้อมูลทั้งหมดด้านล่าง</p>
                  )}
                  <details open={cards.length === 0}>
                    <summary>ข้อมูลทั้งหมดที่ TikTok ส่งมา</summary>
                    <Tree value={r.data} />
                  </details>
                </>
              )}
            </div>
          );
        })}
        {error && (
          <p className="cyber-account-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="cyber-live-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
