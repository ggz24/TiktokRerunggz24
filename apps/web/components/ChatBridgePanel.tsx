'use client';
import { useEffect, useState } from 'react';
import { apiPath } from '@/lib/base-path';

export default function ChatBridgePanel({
  accountId,
  onRefresh,
}: {
  accountId: string;
  onRefresh: () => void;
}) {
  const [pairing, setPairing] = useState('');
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/ai-comments/${accountId}/bridge`;
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const r = await fetch(apiPath(endpoint + '/status'));
        if (r.ok && active) setConnected((await r.json()).connected);
      } catch {
        /* Retry on next refresh. */
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [endpoint]);
  async function change(action: 'pair' | 'revoke') {
    setBusy(true);
    setMessage('');
    try {
      const r = await fetch(apiPath(endpoint + '/' + action), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'เชื่อมต่อไม่สำเร็จ');
      setPairing(action === 'pair' ? JSON.stringify(data) : '');
      setConnected(false);
      setMessage(
        action === 'pair' ? 'คัดลอกรหัสด้านล่างไปวางในส่วนเชื่อม Chrome' : 'ยกเลิกการเชื่อมต่อแล้ว',
      );
      onRefresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'เชื่อมต่อไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ai-settings-card">
      <div className="ai-section-heading">
        <span>▪</span>
        <h3>เชื่อมแชท TikTok ใน Chrome</h3>
      </div>
      <p>{connected ? 'เชื่อมแชทแล้ว' : 'รอส่วนเชื่อม Chrome'} · ใช้กับ Live Hub บนเครื่องนี้</p>
      <p>
        ติดตั้งส่วนเชื่อม Live Hub Chat แล้วเปิด TikTok Shop LIVE Console ของบัญชีนี้ค้างไว้
        เริ่มไลฟ์ก่อนจับคู่ รหัสใช้ได้ 12 ชั่วโมงและใช้เฉพาะห้องปัจจุบัน
      </p>
      <div className="ai-reply-fields">
        <button
          className="cyber-btn"
          type="button"
          disabled={busy}
          onClick={() => void change('pair')}
        >
          สร้างรหัสจับคู่
        </button>
        <button className="cyber-btn" type="button" disabled={busy} onClick={onRefresh}>
          ตรวจการเชื่อมต่อ
        </button>
        <button
          className="cyber-btn"
          type="button"
          disabled={busy}
          onClick={() => void change('revoke')}
        >
          ยกเลิกการเชื่อมต่อ
        </button>
      </div>
      {pairing && (
        <label>
          รหัสจับคู่ — เก็บไว้เป็นส่วนตัว
          <textarea rows={4} readOnly value={pairing} onFocus={(e) => e.target.select()} />
        </label>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
