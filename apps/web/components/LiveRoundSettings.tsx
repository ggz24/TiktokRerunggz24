'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiPath } from '@/lib/base-path';
export type RoundSettings = {
  videoRotation: string[];
  productSetRotation: string[];
  autoAddProducts: boolean;
  autoPinProduct: boolean;
  productPinSelections: Record<string, string>;
};
type Choice = { id: string; name: string; productIds?: string[] };
function RoundList({
  title,
  choices,
  ids,
  onChange,
  empty,
}: {
  title: string;
  choices: Choice[];
  ids: string[];
  onChange: (ids: string[]) => void;
  empty: string;
}) {
  const [selected, setSelected] = useState('');
  const move = (index: number, delta: number) => {
    const next = [...ids];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return (
    <section className="cyber-round-list" aria-label={title}>
      <strong>{title}</strong>
      <div className="cyber-round-picker">
        <select
          aria-label={title + ' — เลือกรายการ'}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">— เลือกรายการ —</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="cyber-btn"
          disabled={!choices.some((c) => c.id === selected) || ids.length >= 100}
          onClick={() => onChange([...ids, selected])}
        >
          ＋ เพิ่มเข้ารายการ
        </button>
      </div>
      {ids.length ? (
        <ol>
          {ids.map((id, index) => (
            <li key={index}>
              <span className="cyber-round-badge">รอบ {index + 1}</span>
              <span className="cyber-round-name">
                {choices.find((c) => c.id === id)?.name ?? 'รายการนี้ถูกลบหรือยังไม่พร้อมใช้งาน'}
              </span>
              <div className="cyber-round-actions">
                <button
                  type="button"
                  className="cyber-btn"
                  aria-label={`เลื่อนรอบ ${index + 1} ขึ้น`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="cyber-btn"
                  aria-label={`เลื่อนรอบ ${index + 1} ลง`}
                  disabled={index === ids.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="cyber-btn"
                  aria-label={`ลบรอบ ${index + 1}`}
                  onClick={() => onChange(ids.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p>{empty}</p>
      )}
      <small>
        ใช้ตามลำดับแล้ววนกลับรอบแรก · เพิ่มรายการเดิมซ้ำได้ ·
        เปลี่ยนลำดับแล้วบันทึกจะเริ่มรายการแรกในรอบใหม่ถัดไป
      </small>
    </section>
  );
}
export default function LiveRoundSettings({
  accountId,
  settings,
  change,
  completed,
}: {
  accountId: string;
  settings: RoundSettings;
  change: (patch: Partial<RoundSettings>) => void;
  completed: number;
}) {
  const [videos, setVideos] = useState<Choice[]>([]),
    [sets, setSets] = useState<Choice[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(apiPath('/api/live/videos'), { cache: 'no-store' }),
      fetch(apiPath('/api/live/product-sets'), { cache: 'no-store' }),
    ])
      .then(async ([v, p]) => {
        if (!v.ok || !p.ok) throw Error('โหลดคลังวิดีโอหรือชุดสินค้าไม่สำเร็จ');
        const [vd, pd] = await Promise.all([v.json(), p.json()]);
        if (!active) return;
        setVideos(
          (vd.items || []).filter((x: { status?: string }) => !x.status || x.status === 'ready'),
        );
        setSets(
          (pd.items || [])
            .filter(
              (x: { accountId: string | null }) =>
                x.accountId === accountId || x.accountId === null,
            )
            .map((x: { id: string; name: string; productIds: string[] }) => ({
              id: x.id,
              name: `${x.name} (${x.productIds.length})`,
              productIds: x.productIds,
            })),
        );
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [accountId]);
  return (
    <div className="cyber-round-settings">
      <h3>🎬 สินค้าและคลิปในแต่ละรอบ</h3>
      <p>
        เริ่มห้องใหม่แล้วเลื่อนไปหนึ่งรอบ · กู้สตรีมกลับห้องเดิมใช้คลิปเดิม · เริ่มห้องใหม่แล้ว{' '}
        {completed} รอบ
      </p>
      <label className="cyber-auto-check">
        <input
          type="checkbox"
          checked={settings.autoAddProducts}
          onChange={(e) => change({ autoAddProducts: e.target.checked })}
        />
        เพิ่มสินค้าเข้าตะกร้าก่อนเริ่มส่งวิดีโอแต่ละรอบ
      </label>
      <label className="cyber-auto-check">
        <input
          type="checkbox"
          checked={settings.autoPinProduct}
          onChange={(e) => change({ autoPinProduct: e.target.checked })}
        />
        ปักหมุดสินค้าที่เลือก หลังเริ่มไลฟ์ประมาณ 5 วินาที
      </label>
      <p>ใช้ session ของบัญชีที่เชื่อมต่อไว้ เลือกสินค้าได้ด้านล่าง ไม่ต้องใส่ cURL ปักหมุด</p>
      <RoundList
        title="📦 ชุดสินค้าต่อรอบ"
        choices={sets}
        ids={settings.productSetRotation}
        onChange={(ids) =>
          change({
            productSetRotation: ids,
            productPinSelections: Object.fromEntries(
              Object.entries(settings.productPinSelections || {}).filter(([id]) =>
                ids.includes(id),
              ),
            ),
          })
        }
        empty="ยังไม่มีรายการต่อรอบ — ใช้ชุดที่เลือกไว้สำหรับเริ่มไลฟ์"
      />
      {settings.autoPinProduct &&
        [...new Set(settings.productSetRotation)].map((id) => {
          const set = sets.find((item) => item.id === id);
          if (!set) return null;
          return (
            <section className="cyber-round-list" key={id}>
              <label>
                📌 สินค้าที่ปักหมุด — {set.name}
                <select
                  aria-label={'สินค้าที่ปักหมุด — ' + set.name}
                  value={settings.productPinSelections?.[id] || set.productIds?.[0] || ''}
                  onChange={(e) =>
                    change({
                      productPinSelections: {
                        ...settings.productPinSelections,
                        [id]: e.target.value,
                      },
                    })
                  }
                >
                  {(set.productIds || []).map((product, index) => (
                    <option key={product} value={product}>
                      สินค้า {index + 1} · {product}
                    </option>
                  ))}
                </select>
              </label>
              <small>ใช้สินค้านี้ทุกครั้งที่ถึงรอบของชุดนี้ · หากไม่เลือกจะปักสินค้าตัวแรก</small>
            </section>
          );
        })}
      <p>
        <Link href="/products">สร้างหรือแก้ชุดสินค้าในคลัง</Link> ·
        เลือกชุดของบัญชีนี้หรือชุดที่ยังไม่ผูกบัญชีได้ ระบบตรวจ session ก่อนบันทึก
      </p>
      <RoundList
        title="🎞 คลิปรีรันต่อรอบ"
        choices={videos}
        ids={settings.videoRotation}
        onChange={(ids) => change({ videoRotation: ids })}
        empty="ยังไม่มีรายการต่อรอบ — ใช้วิดีโอหลักของบัญชี"
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
