'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiPath } from '@/lib/base-path';

type ProductSet = {
  id: string;
  name: string;
  accountId: string | null;
  productIds: string[];
  roomId: string;
  autoApply: boolean;
};

export default function QuickProductSetPanel({ accountId }: { accountId: string }) {
  const [sets, setSets] = useState<ProductSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch(apiPath('/api/live/product-sets'), { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('โหลดชุดสินค้าไม่สำเร็จ');
        return response.json();
      })
      .then((result: { items?: ProductSet[] }) => {
        if (active)
          setSets(
            Array.isArray(result.items)
              ? result.items.filter(
                  (item) => item.accountId === accountId || item.accountId === null,
                )
              : [],
          );
      })
      .catch(() => {
        if (active) setError('โหลดชุดสินค้าไม่สำเร็จ กรุณาลองอีกครั้ง');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId]);

  async function send(item: ProductSet) {
    if (sendingId) return;
    const accountWarning =
      item.accountId === null
        ? 'ชุดนี้ไม่ได้ผูกกับบัญชีบนการ์ด ตรวจว่า Cookie ใน cURL เป็นบัญชีที่ต้องการ\n'
        : '';
    if (
      !window.confirm(
        `${accountWarning}ส่งชุด “${item.name}” (${item.productIds.length} รายการ) เข้า TikTok Shop Streamer Desktop จริงหรือไม่?`,
      )
    )
      return;
    setSendingId(item.id);
    setMessage('');
    setError('');
    try {
      const response = await fetch(apiPath(`/api/live/product-sets/${item.id}/send`), {
        method: 'POST',
      });
      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null);
        throw new Error(
          result &&
            typeof result === 'object' &&
            'error' in result &&
            typeof result.error === 'string'
            ? result.error
            : 'ส่งชุดสินค้าไม่สำเร็จ',
        );
      }
      const result = (await response.json()) as { outcome?: string; queuedForLive?: boolean };
      if (result.outcome === 'queued' || result.outcome === 'accepted') {
        setSets((current) =>
          current.map((set) => ({
            ...set,
            autoApply: set.accountId === item.accountId ? set.id === item.id : set.autoApply,
          })),
        );
      }
      setMessage(
        result.outcome === 'queued'
          ? `บันทึกชุด “${item.name}” เพื่อส่งเข้าห้องใหม่เมื่อกดเริ่มไลฟ์`
          : result.outcome === 'accepted'
            ? `TikTok Shop ตอบรับชุด “${item.name}” แล้ว${result.queuedForLive ? ' และจะส่งซ้ำเมื่อเริ่มไลฟ์' : ''} ตรวจรายการใน Streamer Desktop`
            : `ส่งชุด “${item.name}” แล้ว แต่ยืนยันผลไม่ได้ ตรวจรายการใน Streamer Desktop`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ส่งชุดสินค้าไม่สำเร็จ');
    } finally {
      setSendingId('');
    }
  }

  return (
    <div className="cyber-quick-product-sets">
      <p>เลือกชุดที่บันทึกไว้ แล้วกดส่งสินค้าเข้า TikTok Shop Streamer Desktop</p>
      {loading ? (
        <p>กำลังโหลดชุดสินค้า…</p>
      ) : sets.length === 0 ? (
        <p>ยังไม่มีชุดสินค้าสำหรับบัญชีนี้</p>
      ) : (
        <div className="cyber-product-set-list">
          {sets.map((item) => (
            <div className="cyber-product-set-row" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>
                  {item.productIds.length} รายการ ·{' '}
                  {item.accountId ? 'ส่งซ้ำเมื่อบัญชีนี้เริ่ม LIVE' : 'ใช้ Cookie ใน cURL'}
                  {item.autoApply ? ' · ใช้เมื่อเริ่มไลฟ์' : ''}
                </small>
              </div>
              <button
                type="button"
                className="cyber-btn green"
                disabled={Boolean(sendingId)}
                onClick={() => void send(item)}
              >
                {sendingId === item.id ? 'กำลังส่ง…' : 'ส่งเข้า LIVE'}
              </button>
            </div>
          ))}
        </div>
      )}
      <Link className="cyber-btn cyan" href="/products">
        จัดการหรือเพิ่มชุดสินค้า
      </Link>
      {error && (
        <p className="cyber-account-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="cyber-live-notice" role="status">
          {message}
        </p>
      )}
      <p>คำขอนี้เพิ่มสินค้าเข้ารายการ ส่วนการปักแสดงสินค้าเด่นบนจอ LIVE ใช้คำสั่งอีกชนิด</p>
    </div>
  );
}
