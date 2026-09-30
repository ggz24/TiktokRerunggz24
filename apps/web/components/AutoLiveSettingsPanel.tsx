'use client';

import { useEffect, useState } from 'react';

type Settings = {
  endAfterMinutes: number | null;
  restartAfterMinutes: number | null;
  dailyStartTime: string | null;
  recoverStream: boolean;
  closedRoomAction: 'new_room' | 'stop';
};
const defaults: Settings = {
  endAfterMinutes: null,
  restartAfterMinutes: null,
  dailyStartTime: null,
  recoverStream: false,
  closedRoomAction: 'stop',
};

export default function AutoLiveSettingsPanel({ accountId }: { accountId: string }) {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [phase, setPhase] = useState('idle');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const path = `/api/live/sessions/${encodeURIComponent(accountId)}/auto-settings`;

  useEffect(() => {
    let active = true;
    fetch(path, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('โหลดโหมด AUTO ไม่สำเร็จ');
        return response.json();
      })
      .then((data) => {
        if (!active) return;
        setSettings(data.item.settings);
        setPhase(data.item.phase);
        setMessage(data.item.lastError ? `ข้อผิดพลาดล่าสุด: ${data.item.lastError}` : '');
      })
      .catch(() => active && setMessage('โหลดโหมด AUTO ไม่สำเร็จ'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [path]);

  const change = (patch: Partial<Settings>) => setSettings((current) => ({ ...current, ...patch }));
  async function save() {
    if (settings.restartAfterMinutes !== null && settings.endAfterMinutes === null) {
      setMessage('เปิดลงไลฟ์เมื่อครบเวลาก่อนเปิดพักแล้วเริ่มใหม่');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error('บันทึกไม่สำเร็จ ตรวจเวลาและลองอีกครั้ง');
      const data = await response.json();
      setSettings(data.item.settings);
      setPhase(data.item.phase);
      setMessage('บันทึกโหมด AUTO แล้ว');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cyber-stream-settings cyber-auto-settings">
      <strong>⏱ โหมดอัตโนมัติ — ไลฟ์ (AUTO)</strong>
      <p>สถานะ: {phase === 'live' ? 'กำลังทำงาน' : phase === 'resting' ? 'กำลังพัก' : 'รอเริ่ม'}</p>
      {loading ? (
        <p>กำลังโหลด…</p>
      ) : (
        <>
          <label className="cyber-auto-check">
            <input
              type="checkbox"
              checked={settings.endAfterMinutes !== null}
              onChange={(event) =>
                change({
                  endAfterMinutes: event.target.checked ? 10 : null,
                  ...(event.target.checked ? {} : { restartAfterMinutes: null }),
                })
              }
            />
            ⏬ ลงไลฟ์เองเมื่อออกอากาศครบเวลา
          </label>
          {settings.endAfterMinutes !== null && (
            <label>
              ออกอากาศนาน (นาที)
              <input
                type="number"
                min={1}
                max={1440}
                value={settings.endAfterMinutes}
                onChange={(event) => change({ endAfterMinutes: Number(event.target.value) })}
              />
            </label>
          )}
          <label className="cyber-auto-check">
            <input
              type="checkbox"
              checked={settings.restartAfterMinutes !== null}
              disabled={settings.endAfterMinutes === null}
              onChange={(event) =>
                change({ restartAfterMinutes: event.target.checked ? 30 : null })
              }
            />
            ⏫ พักครบเวลาแล้วเริ่มไลฟ์ใหม่
          </label>
          {settings.restartAfterMinutes !== null && (
            <label>
              พักนาน (นาที)
              <input
                type="number"
                min={1}
                max={1440}
                value={settings.restartAfterMinutes}
                onChange={(event) => change({ restartAfterMinutes: Number(event.target.value) })}
              />
            </label>
          )}
          <label className="cyber-auto-check">
            <input
              type="checkbox"
              checked={settings.dailyStartTime !== null}
              onChange={(event) =>
                change({ dailyStartTime: event.target.checked ? '17:00' : null })
              }
            />
            ⏰ เริ่มไลฟ์ทุกวันตามเวลาไทย
          </label>
          {settings.dailyStartTime !== null && (
            <label>
              เวลาเริ่ม (Asia/Bangkok)
              <input
                type="time"
                value={settings.dailyStartTime}
                onChange={(event) => change({ dailyStartTime: event.target.value })}
              />
            </label>
          )}
          <label className="cyber-auto-check">
            <input
              type="checkbox"
              checked={settings.recoverStream}
              onChange={(event) => change({ recoverStream: event.target.checked })}
            />
            🔄 สตรีมหลุดแล้วกู้คืนอัตโนมัติ
          </label>
          {settings.recoverStream && (
            <label>
              ถ้าห้องเดิมปิดไปแล้ว
              <select
                value={settings.closedRoomAction}
                onChange={(event) =>
                  change({ closedRoomAction: event.target.value as Settings['closedRoomAction'] })
                }
              >
                <option value="new_room">เปิดห้องใหม่อัตโนมัติ</option>
                <option value="stop">หยุดและรอคำสั่ง</option>
              </select>
            </label>
          )}
          <p>การเริ่มอัตโนมัติใช้ชื่อไลฟ์และวิดีโอที่บันทึกไว้ของบัญชีนี้</p>
          <button
            type="button"
            className="cyber-btn pink"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? 'กำลังบันทึก…' : 'บันทึกโหมด AUTO'}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
