'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiPath } from '@/lib/base-path';
import { confirmDialog } from '@/lib/confirm';

type Computer = { id: string; name: string; online: boolean; lastSeen: number | null };
type Pairing = { code: string; expiresAt: number };

const post = (path: string, body: object = {}) =>
  fetch(apiPath(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

export default function BoxphonePanel() {
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('กำลังตรวจการเชื่อมต่อ Boxphone…');
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<'local' | 'agent' | null>(null);
  const [computers, setComputers] = useState<Computer[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());

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
    void fetch(apiPath('/api/boxphone/computers'), { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok || !active) return;
        const data = await r.json();
        setMode(data.mode === 'agent' ? 'agent' : 'local');
        setComputers(Array.isArray(data.computers) ? data.computers : []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [version]);

  // Keep looking while no computer is connected, and keep the list of computers fresh.
  useEffect(() => {
    const timer = setInterval(() => setVersion((v) => v + 1), ready ? 30000 : 10000);
    return () => clearInterval(timer);
  }, [ready]);
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const createCode = useCallback(async () => {
    setNotice('');
    try {
      const r = await post('/api/boxphone/pair');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'สร้างรหัสไม่สำเร็จ');
      setPairing({ code: data.code, expiresAt: Date.parse(data.expiresAt) });
      setNow(Date.now());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'สร้างรหัสไม่สำเร็จ');
    }
  }, []);

  const remove = useCallback(async (computer: Computer) => {
    if (
      !(await confirmDialog(
        `ตัดการเชื่อมต่อคอม "${computer.name}" ใช่ไหม? ต้องจับคู่ใหม่ถ้าจะกลับมาใช้`,
      ))
    )
      return;
    const r = await post('/api/boxphone/computer-remove', { id: computer.id });
    if (!r.ok) setNotice((await r.json().catch(() => ({}))).error || 'ลบไม่สำเร็จ');
    setVersion((v) => v + 1);
  }, []);

  const secondsLeft = pairing ? Math.max(0, Math.floor((pairing.expiresAt - now) / 1000)) : 0;
  const hosted = mode === 'agent';
  const code = pairing && secondsLeft > 0 ? pairing.code : null;
  const pretty = code ? `${code.slice(0, 4)}-${code.slice(4)}` : '';

  const pairingCard = (
    <div className="ai-settings-card boxphone-pair">
      {code ? (
        <>
          <p>
            รหัสจับคู่ (ใช้ได้ครั้งเดียว เหลือ {Math.floor(secondsLeft / 60)}:
            {String(secondsLeft % 60).padStart(2, '0')} นาที)
          </p>
          <p className="boxphone-code">{pretty}</p>
          <ol>
            <li>
              บนคอมที่ต่อโทรศัพท์ เปิดหน้านี้แล้วกด{' '}
              <a
                className="cyber-btn"
                href={apiPath(`/api/boxphone/installer?code=${code}`)}
                download
              >
                ดาวน์โหลดตัวติดตั้ง
              </a>
            </li>
            <li>
              ดับเบิลคลิกไฟล์ <strong>Boxphone-Setup.cmd</strong> ที่ได้ (ถ้า Windows เตือน กด
              &quot;ข้อมูลเพิ่มเติม&quot; แล้ว &quot;เรียกใช้อยู่ดี&quot;)
            </li>
            <li>
              รอจนขึ้นว่า Done แล้วกลับมาหน้านี้ คอมเครื่องนั้นจะขึ้นในรายการภายใน 10 วินาที
              ไม่ต้องตั้งค่าอะไรอีก
            </li>
          </ol>
          <p>
            ตัวติดตั้งจะตั้งให้เริ่มเองทุกครั้งที่ล็อกอิน Windows ต้องมี Xiaowei
            ติดตั้งบนคอมเครื่องนั้นและต่อโทรศัพท์ไว้
          </p>
        </>
      ) : (
        <>
          <p>
            เพิ่มคอมที่ต่อโทรศัพท์ได้หลายเครื่อง ใช้คอมเครื่องไหนก็ได้ ไม่ต้องตั้งค่าเอง
            กดสร้างรหัสแล้วทำตามขั้นตอน
          </p>
          <button className="cyber-btn" type="button" onClick={() => void createCode()}>
            สร้างรหัสจับคู่คอมเครื่องใหม่
          </button>
        </>
      )}
      {notice && <p role="alert">{notice}</p>}
    </div>
  );

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
      {hosted && (
        <details className="boxphone-computers" open={!ready}>
          <summary>
            คอมที่เชื่อมต่อ ({computers.filter((c) => c.online).length}/{computers.length} ออนไลน์)
          </summary>
          {computers.length === 0 ? (
            <p>ยังไม่มีคอมที่จับคู่ เริ่มจากเพิ่มคอมเครื่องแรกด้านล่าง</p>
          ) : (
            <ul>
              {computers.map((c) => (
                <li key={c.id}>
                  <span className={c.online ? 'boxphone-on' : 'boxphone-off'}>●</span> {c.name}{' '}
                  {c.online ? 'ออนไลน์' : 'ออฟไลน์ (เปิดคอมเครื่องนั้นและรอสักครู่)'}
                  {c.id !== 'legacy' && (
                    <button className="cyber-btn" type="button" onClick={() => void remove(c)}>
                      ตัดการเชื่อมต่อ
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {pairingCard}
        </details>
      )}
      {ready ? (
        <iframe
          title="Boxphone · ควบคุมมือถือและ AI"
          src={apiPath('/api/boxphone/view')}
          allow="microphone; display-capture"
          className="boxphone-frame"
        />
      ) : hosted ? (
        <div className="ai-settings-card">
          <p>
            {computers.length === 0
              ? 'ยังไม่มีคอมที่ต่อโทรศัพท์ เพิ่มคอมเครื่องแรกด้วยรหัสจับคู่ด้านบน'
              : 'ยังไม่มีคอมออนไลน์ เปิดคอมที่ต่อโทรศัพท์ไว้ ตัวเชื่อมจะเริ่มเองตอนล็อกอิน Windows หน้านี้ตรวจซ้ำให้อัตโนมัติ'}
          </p>
        </div>
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
