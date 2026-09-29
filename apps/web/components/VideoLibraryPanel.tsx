'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Upload } from 'lucide-react';
import {
  maxLibraryBytes,
  maxLibraryVideos,
  maxVideoBytes,
  type StoredVideo,
  uploadMp4,
} from '@/lib/video-upload';

function sizeLabel(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export default function VideoLibraryPanel() {
  const [videos, setVideos] = useState<StoredVideo[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'upload' | 'delete' | ''>('');
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/live/videos', { cache: 'no-store' });
      if (!response.ok) throw new Error('โหลดคลังวิดีโอไม่สำเร็จ');
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== 'object' ||
        !('items' in result) ||
        !Array.isArray(result.items)
      ) {
        throw new Error('อ่านข้อมูลคลังวิดีโอไม่สำเร็จ');
      }
      setVideos(result.items as StoredVideo[]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'โหลดคลังวิดีโอไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    if (!file.name.toLowerCase().endsWith('.mp4') || file.size < 1 || file.size > maxVideoBytes) {
      setError('เลือกไฟล์ MP4 ขนาดไม่เกิน 8 GB');
      return;
    }
    const used = videos.reduce((sum, video) => sum + video.sizeBytes, 0);
    if (videos.length >= maxLibraryVideos || used + file.size > maxLibraryBytes) {
      setError('พื้นที่คลัง 40 GB หรือจำนวน 100 ไฟล์เต็มแล้ว');
      return;
    }
    setBusy('upload');
    setProgress(0);
    setError('');
    setNotice('');
    try {
      const item = await uploadMp4(file, setProgress);
      setVideos((current) => [item, ...current]);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setNotice('อัปโหลดวิดีโอเรียบร้อยแล้ว ใช้ไฟล์นี้ได้ในหน้า Live Session');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'อัปโหลดวิดีโอไม่สำเร็จ');
    } finally {
      setBusy('');
      setProgress(null);
    }
  }

  async function remove(video: StoredVideo) {
    if (busy || !window.confirm(`ลบ ${video.name} ออกจากคลังวิดีโอ?`)) return;
    setBusy('delete');
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/live/videos/${encodeURIComponent(video.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? 'วิดีโอนี้กำลังถูกใช้ใน Live Session กรุณาเปลี่ยนวิดีโอก่อนลบ'
            : 'ลบวิดีโอไม่สำเร็จ',
        );
      }
      setVideos((current) => current.filter((item) => item.id !== video.id));
      setNotice('ลบวิดีโอแล้ว');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ลบวิดีโอไม่สำเร็จ');
    } finally {
      setBusy('');
    }
  }

  const usedBytes = videos.reduce((sum, video) => sum + video.sizeBytes, 0);
  return (
    <>
      <section className="cyber-panel">
        <div className="cyber-panel-title">
          <span className="cyber-spark">▪</span> อัปโหลด MP4
        </div>
        <div className="cyber-live-section">
          <p>สูงสุด 8 GB ต่อไฟล์ · คลังรวม 40 GB · ไม่เกิน 100 ไฟล์</p>
          <form className="cyber-live-form" onSubmit={upload}>
            <label>
              เลือกไฟล์จากเครื่อง
              <input
                ref={fileInput}
                type="file"
                accept="video/mp4,.mp4"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                disabled={busy !== ''}
              />
            </label>
            <button className="cyber-btn cyan" type="submit" disabled={!file || busy !== ''}>
              <Upload size={13} /> {busy === 'upload' ? 'กำลังอัปโหลด…' : 'อัปโหลด MP4'}
            </button>
          </form>
          {busy === 'upload' && progress !== null && (
            <div role="status">
              กำลังอัปโหลด {progress}% — รอให้ระบบบันทึกไฟล์เสร็จก่อนปิดหน้านี้
              <progress value={progress} max={100} style={{ display: 'block', width: '100%' }} />
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>
      </section>
      <section className="cyber-panel">
        <div className="cyber-panel-title">
          <span className="cyber-spark">▪</span> วิดีโอในคลัง
          <span className="cyber-panel-action">
            <button
              className="cyber-btn"
              type="button"
              onClick={() => void refresh()}
              disabled={loading || busy !== ''}
            >
              <RefreshCw size={13} /> รีเฟรช
            </button>
          </span>
        </div>
        <div className="cyber-live-section">
          <p>
            {videos.length} / {maxLibraryVideos} ไฟล์ · ใช้ไป {sizeLabel(usedBytes)} / 40 GB
          </p>
          {loading ? (
            <p>กำลังโหลดคลังวิดีโอ…</p>
          ) : videos.length === 0 ? (
            <p>ยังไม่มีวิดีโอในคลัง</p>
          ) : (
            <div className="cyber-live-video-list">
              {videos.map((video) => (
                <div key={video.id}>
                  <span>
                    {video.name} · {sizeLabel(video.sizeBytes)}
                  </span>
                  <button
                    className="cyber-btn danger"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => void remove(video)}
                  >
                    ลบ
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
