'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RadioTower } from 'lucide-react';
import { apiPath } from '@/lib/base-path';
export default function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch(apiPath('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      router.replace('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-bg">
      <div className="login-card">
        <div className="brand-mark">
          <RadioTower size={26} />
        </div>
        <div className="eyebrow">TEAM OPERATIONS</div>
        <h1>Live Hub</h1>
        <p>เข้าสู่ระบบเพื่อจัดการงานไลฟ์ของทีม</p>
        <form onSubmit={submit}>
          <label>
            ชื่อผู้ใช้
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="กรอกชื่อผู้ใช้"
            />
          </label>
          <label>
            รหัสผ่าน
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="กรอกรหัสผ่าน"
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary wide" disabled={busy}>
            {busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>
        <small>ระบบตัวอย่างสำหรับวางโครงทีม</small>
      </div>
    </main>
  );
}
