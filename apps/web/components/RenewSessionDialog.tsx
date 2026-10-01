'use client';

import { useEffect, useState } from 'react';
import { apiPath } from '@/lib/base-path';

export default function RenewSessionDialog({
  account,
  onClose,
  onDone,
}: {
  account: { id: string; alias: string; verifiedHandle?: string | null };
  onClose: () => void;
  onDone: (item: unknown) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        apiPath(`/api/accounts/${encodeURIComponent(account.id)}/session`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            /^curl(\.exe)?\s/i.test(value) ? { curl: value } : { sessionid: value },
          ),
        },
      );
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          result &&
          typeof result === 'object' &&
          'error' in result &&
          typeof result.error === 'string'
            ? result.error
            : 'อัปเดต session ไม่สำเร็จ กรุณาลองอีกครั้ง';
        throw new Error(message);
      }
      // The pasted session is never kept in the page after it has been saved.
      setText('');
      onDone(result && typeof result === 'object' && 'item' in result ? result.item : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'อัปเดต session ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`อัปเดต session ของ ${account.alias}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(5,4,15,.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          background: '#1f1b3a',
          border: '2px solid #7c5cff',
          maxWidth: 560,
          width: '100%',
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <strong>
          อัปเดต session · {account.alias}
          {account.verifiedHandle ? ` (@${account.verifiedHandle})` : ''}
        </strong>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          วาง cURL (Copy as cURL bash) หรือ sessionid ใหม่ของ<b>ไอดีเดียวกัน</b> ตั้งค่าไลฟ์
          ชื่อห้อง และชุดสินค้าของบัญชีนี้ยังอยู่ครบ
          <br />
          ทำให้ session ไม่หลุด: คัดลอกจากหน้าต่าง Incognito ที่ล็อกอินไอดีนี้ไอดีเดียว
          แล้วปิดหน้าต่างทิ้ง <b>ห้ามกดออกจากระบบ</b> และห้ามสลับไปไอดีอื่นในหน้าต่างเดิม
        </p>
        <textarea
          className="cyber-textarea"
          rows={8}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          placeholder="curl 'https://www.tiktok.com/api/update/profile/' ... หรือ sessionid"
          autoFocus
        />
        {error && (
          <p role="alert" style={{ margin: 0, color: '#ff6b9d' }}>
            {error}
          </p>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="cyber-btn" type="button" disabled={busy} onClick={onClose}>
            ยกเลิก
          </button>
          <button
            className="cyber-btn pink"
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'กำลังตรวจกับ TikTok…' : 'บันทึก session ใหม่'}
          </button>
        </div>
      </div>
    </div>
  );
}
