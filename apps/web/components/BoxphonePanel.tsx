'use client';

import { useEffect, useState } from 'react';
import { apiPath } from '@/lib/base-path';

export default function BoxphonePanel() {
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('กำลังตรวจการเชื่อมต่อ Boxphone…');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    void fetch(apiPath('/api/boxphone/health'), { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json();
        if (active) {
          setReady(r.ok && data.app === 'boxphone-lab');
          setMessage(r.ok ? 'เชื่อมต่อโปรแกรมในเครื่องแล้ว' : data.error || 'ยังเชื่อมต่อไม่ได้');
        }
      })
      .catch(() => {
        if (active) {
          setReady(false);
          setMessage('ยังเชื่อมต่อโปรแกรมในเครื่องไม่ได้');
        }
      });
    return () => {
      active = false;
    };
  }, [version]);
  // Keep looking while the computer holding the phones is not connected yet.
  useEffect(() => {
    if (ready) return;
    const timer = setInterval(() => setVersion((v) => v + 1), 10000);
    return () => clearInterval(timer);
  }, [ready]);
  return (
    <section className="boxphone-panel">
      <div className="boxphone-heading">
        <div>
          <h2>Boxphone</h2>
          <p>{message}</p>
        </div>
        {!ready && (
          <button className="cyber-btn" type="button" onClick={() => setVersion((v) => v + 1)}>
            ตรวจการเชื่อมต่ออีกครั้ง
          </button>
        )}
      </div>
      {ready ? (
        <iframe
          title="Boxphone · ควบคุมมือถือและ AI"
          src={apiPath('/api/boxphone/view')}
          allow="microphone; display-capture"
          className="boxphone-frame"
        />
      ) : (
        <div className="ai-settings-card">
          <p>
            ตัวเชื่อม Boxphone จะเริ่มเองเมื่อคอมที่ต่อมือถือเปิดและล็อกอิน Windows
            หน้านี้ตรวจซ้ำให้อัตโนมัติทุก 10 วินาที ถ้ายังไม่เชื่อมต่อ ให้เปิดไฟล์{' '}
            <strong>Start-Boxphone.cmd</strong> ในโฟลเดอร์ Live Hub บนคอมเครื่องนั้นหนึ่งครั้ง
          </p>
          <p>
            ต้องเปิดหน้าควบคุมนี้ไว้ระหว่างฟังเสียงหรือเดินคิว เมื่อออกจากหน้า
            ระบบจะหยุดงานในหน้านี้
          </p>
        </div>
      )}
    </section>
  );
}
