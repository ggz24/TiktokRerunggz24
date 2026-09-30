'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Settings, Square, Upload, X } from 'lucide-react';
import { maxVideoBytes, uploadMp4 } from '@/lib/video-upload';

type LiveAccount = {
  id: string;
  alias: string;
  verifiedHandle?: string | null;
  liveTitle?: string | null;
  verificationStatus: 'connected' | 'pending_verification' | 'disconnected';
};

type LiveVideo = {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
};

type LiveSession = {
  accountId: string;
  status: 'idle' | 'starting' | 'live' | 'stopping' | 'failed';
  videoId?: string | null;
  videoName?: string | null;
  hasRtmpConfig: boolean;
  hasOpenRoom: boolean;
  startedAt?: string | null;
  error?: string | null;
};

function statusLabel(status: LiveSession['status']) {
  switch (status) {
    case 'starting':
      return 'กำลังเริ่มส่งสัญญาณ';
    case 'live':
      return 'กำลังส่งสัญญาณ';
    case 'stopping':
      return 'กำลังหยุด';
    case 'failed':
      return 'ส่งสัญญาณไม่สำเร็จ';
    default:
      return 'ยังไม่เริ่ม';
  }
}

function streamErrorText(error?: string | null) {
  if (!error) return 'ตัวส่งวิดีโอหยุดทำงาน กรุณาตรวจสอบห้อง LIVE แล้วลองใหม่';
  if (error.includes('rejected the connection'))
    return 'ปลายทางปฏิเสธการเชื่อมต่อ ห้อง LIVE หรือ stream key อาจหมดอายุ กรุณาเปิดห้องใหม่';
  if (error.includes('was interrupted'))
    return 'การเชื่อมต่อกับปลายทางขาดหาย กรุณาตรวจสอบอินเทอร์เน็ตและสถานะห้อง LIVE';
  if (error.includes('encoding stopped')) return 'การแปลงวิดีโอหยุดทำงาน กรุณาตรวจสอบไฟล์ MP4';
  return 'ตัวส่งวิดีโอหยุดทำงาน กรุณาตรวจสอบห้อง LIVE แล้วลองใหม่';
}

function requestError(status: number, action: string) {
  if (status === 401) return 'กรุณาเข้าสู่ระบบอีกครั้ง';
  if (status === 404) return 'ไม่พบบัญชีหรือวิดีโอที่เลือก กรุณารีเฟรชข้อมูล';
  if (status === 409) return 'สถานะสตรีมเปลี่ยนไป กรุณารีเฟรชแล้วลองอีกครั้ง';
  if (status === 413) return 'ไฟล์ MP4 ใหญ่เกิน 8 GB หรือพื้นที่คลังเต็ม';
  if (status === 503 && action === 'สร้างห้อง LIVE')
    return 'ระบบดึงคีย์อัตโนมัติยังไม่พร้อม กรุณาตรวจการตั้งค่า RapidAPI บนเซิร์ฟเวอร์';
  if (status === 400 || status === 415 || status === 422) {
    return 'ข้อมูลสตรีมไม่ถูกต้อง กรุณาตรวจสอบ RTMP URL, stream key และวิดีโอ';
  }
  return `${action}ไม่สำเร็จ กรุณาลองอีกครั้ง`;
}

export default function LiveSessionPanel({
  accounts,
  onLiveCount,
  onSetup,
}: {
  accounts: LiveAccount[];
  onLiveCount: (count: number) => void;
  onSetup: (accountId: string) => void;
}) {
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [videos, setVideos] = useState<LiveVideo[]>([]);
  const [videoSelection, setVideoSelection] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState<'upload' | 'video' | 'start' | 'stop' | 'delete' | ''>('');
  const [liveTitle, setLiveTitle] = useState('');
  const [createdRoomId, setCreatedRoomId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [deletingVideoId, setDeletingVideoId] = useState('');
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const statusQueryHandled = useRef(false);

  useEffect(() => {
    if (!statusModalOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setStatusModalOpen(false);
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [statusModalOpen]);

  const loadLive = useCallback(async () => {
    try {
      const [sessionsResponse, videosResponse] = await Promise.all([
        fetch('/api/live/sessions', { cache: 'no-store' }),
        fetch('/api/live/videos', { cache: 'no-store' }),
      ]);
      if (!sessionsResponse.ok || !videosResponse.ok) {
        throw new Error('โหลดข้อมูลไลฟ์ไม่สำเร็จ กรุณาลองอีกครั้ง');
      }
      const sessionData: unknown = await sessionsResponse.json();
      const videoData: unknown = await videosResponse.json();
      if (
        !sessionData ||
        typeof sessionData !== 'object' ||
        !('items' in sessionData) ||
        !Array.isArray(sessionData.items) ||
        !videoData ||
        typeof videoData !== 'object' ||
        !('items' in videoData) ||
        !Array.isArray(videoData.items)
      ) {
        throw new Error('โหลดข้อมูลไลฟ์ไม่สำเร็จ กรุณาลองอีกครั้ง');
      }
      setSessions(sessionData.items as LiveSession[]);
      setVideos(videoData.items as LiveVideo[]);
      setStatusUnavailable(false);
      setError('');
    } catch (caught) {
      setStatusUnavailable(true);
      setError(caught instanceof Error ? caught.message : 'โหลดข้อมูลไลฟ์ไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLive();
  }, [loadLive]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('accountId');
    const firstConnected = accounts.find((account) => account.verificationStatus === 'connected');
    setSelectedAccountId((current) => {
      if (current && accounts.some((account) => account.id === current)) return current;
      if (
        requested &&
        accounts.some(
          (account) => account.id === requested && account.verificationStatus === 'connected',
        )
      )
        return requested;
      return firstConnected?.id ?? '';
    });
  }, [accounts]);

  useEffect(() => {
    if (statusQueryHandled.current || !selectedAccountId) return;
    const query = new URLSearchParams(window.location.search);
    if (query.get('status') !== '1' || query.get('accountId') !== selectedAccountId) return;
    statusQueryHandled.current = true;
    setStatusModalOpen(true);
    query.delete('status');
    window.history.replaceState(null, '', `${window.location.pathname}?${query.toString()}`);
  }, [selectedAccountId]);

  const refreshSessions = useCallback(async () => {
    try {
      const response = await fetch('/api/live/sessions', { cache: 'no-store' });
      if (!response.ok) throw new Error('status unavailable');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) {
        throw new Error('invalid status');
      }
      setSessions(data.items as LiveSession[]);
      setStatusUnavailable(false);
    } catch {
      setStatusUnavailable(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshSessions(), 5000);
    return () => window.clearInterval(timer);
  }, [refreshSessions]);

  const refreshStatus = useCallback(async (accountId: string) => {
    try {
      const response = await fetch(`/api/live/sessions/${encodeURIComponent(accountId)}/status`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        setStatusUnavailable(true);
        return;
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('item' in data) || !data.item) {
        setStatusUnavailable(true);
        return;
      }
      const item = data.item as LiveSession;
      setSessions((current) => [
        ...current.filter((session) => session.accountId !== accountId),
        item,
      ]);
      setStatusUnavailable(false);
    } catch {
      setStatusUnavailable(true);
    }
  }, []);

  useEffect(() => {
    if (!selectedAccountId) return;
    void refreshStatus(selectedAccountId);
  }, [selectedAccountId, refreshStatus]);

  useEffect(() => {
    onLiveCount(
      statusUnavailable ? 0 : sessions.filter((session) => session.status === 'live').length,
    );
  }, [sessions, statusUnavailable, onLiveCount]);

  const account = accounts.find((item) => item.id === selectedAccountId);
  const session = sessions.find((item) => item.accountId === selectedAccountId);
  const status = session?.status ?? 'idle';
  const selectedVideoId = videoSelection[selectedAccountId] ?? session?.videoId ?? '';
  const connected = account?.verificationStatus === 'connected';
  useEffect(() => {
    setLiveTitle(account?.liveTitle ?? '');
    setCreatedRoomId('');
  }, [account?.id, account?.liveTitle]);
  const active = status === 'starting' || status === 'live' || status === 'stopping';
  const canStart = Boolean(
    connected &&
    selectedVideoId &&
    liveTitle.trim() &&
    !active &&
    !session?.hasOpenRoom &&
    !busy &&
    !statusUnavailable,
  );

  async function uploadVideo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    if (!file.name.toLowerCase().endsWith('.mp4') || file.size < 1 || file.size > maxVideoBytes) {
      setError('เลือกไฟล์ MP4 ขนาดไม่เกิน 8 GB');
      return;
    }
    setBusy('upload');
    setUploadProgress(0);
    setError('');
    setNotice('');
    try {
      const item = await uploadMp4(file, setUploadProgress);
      setVideos((current) => [item, ...current.filter((video) => video.id !== item.id)]);
      if (selectedAccountId) {
        setVideoSelection((current) => ({ ...current, [selectedAccountId]: item.id }));
      }
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setNotice('วิดีโอพร้อมใช้งานแล้ว เลือกบัญชีและตั้งค่าการส่งสัญญาณก่อนเริ่ม');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'อัปโหลดวิดีโอไม่สำเร็จ');
    } finally {
      setBusy('');
      setUploadProgress(null);
    }
  }

  async function saveVideoSelection() {
    if (!selectedAccountId || !connected || !selectedVideoId || busy) return;
    setBusy('video');
    setError('');
    setNotice('');
    try {
      const response = await fetch(
        `/api/live/sessions/${encodeURIComponent(selectedAccountId)}/video`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: selectedVideoId }),
        },
      );
      if (!response.ok) throw new Error(requestError(response.status, 'บันทึกวิดีโอ'));
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('item' in data) || !data.item) {
        throw new Error('บันทึกวิดีโอไม่สำเร็จ กรุณาลองอีกครั้ง');
      }
      const item = data.item as LiveSession;
      setSessions((current) => [
        ...current.filter((session) => session.accountId !== selectedAccountId),
        item,
      ]);
      setNotice('เลือกวิดีโอที่จะส่งแล้ว');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'บันทึกวิดีโอไม่สำเร็จ');
    } finally {
      setBusy('');
    }
  }

  async function deleteVideo(video: LiveVideo) {
    if (busy || !window.confirm(`ลบวิดีโอ “${video.name}” ออกจากระบบ?`)) return;
    setBusy('delete');
    setDeletingVideoId(video.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/live/videos/${encodeURIComponent(video.id)}`, {
        method: 'DELETE',
      });
      if (response.status === 409) {
        throw new Error(
          'วิดีโอนี้อยู่ในค่าการสตรีมที่บันทึกไว้ กรุณาเปลี่ยนวิดีโอของบัญชีนั้นก่อนลบ',
        );
      }
      if (!response.ok) throw new Error(requestError(response.status, 'ลบวิดีโอ'));
      setVideos((current) => current.filter((item) => item.id !== video.id));
      setVideoSelection((current) =>
        Object.fromEntries(
          Object.entries(current).map(([accountId, id]) => [accountId, id === video.id ? '' : id]),
        ),
      );
      setNotice('ลบวิดีโอแล้ว');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ลบวิดีโอไม่สำเร็จ');
    } finally {
      setBusy('');
      setDeletingVideoId('');
    }
  }

  async function changeStream(action: 'start' | 'stop') {
    if (!selectedAccountId || busy) return;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      if (action === 'start' && selectedVideoId !== session?.videoId) {
        const selected = await fetch(
          `/api/live/sessions/${encodeURIComponent(selectedAccountId)}/video`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId: selectedVideoId }),
          },
        );
        if (!selected.ok) throw new Error(requestError(selected.status, 'บันทึกวิดีโอ'));
      }
      const response = await fetch(
        `/api/live/sessions/${encodeURIComponent(selectedAccountId)}/${action === 'start' ? 'start-auto' : 'stop'}`,
        {
          method: 'POST',
          ...(action === 'start'
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: liveTitle.trim() }),
              }
            : {}),
        },
      );
      if (!response.ok) {
        throw new Error(
          requestError(response.status, action === 'start' ? 'เริ่มสตรีม' : 'หยุดสตรีม'),
        );
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('item' in data) || !data.item) {
        throw new Error('อ่านสถานะสตรีมไม่สำเร็จ กรุณารีเฟรช');
      }
      const item = data.item as LiveSession;
      setSessions((current) => [
        ...current.filter((session) => session.accountId !== selectedAccountId),
        item,
      ]);
      if (action === 'start') {
        setCreatedRoomId('roomId' in data && typeof data.roomId === 'string' ? data.roomId : '');
        setNotice('สร้างห้อง LIVE และเริ่มส่งวิดีโอแล้ว');
        if (
          'productsOutcome' in data &&
          (data.productsOutcome === 'rejected' || data.productsOutcome === 'unverified')
        ) {
          setError(
            'ไลฟ์เริ่มแล้ว แต่ยังเพิ่มชุดสินค้าในตะกร้าไม่ได้ ตรวจชุดสินค้าและคำขอจาก TikTok Shop',
          );
        }
      } else {
        const roomEnd = 'roomEnd' in data ? data.roomEnd : '';
        if (roomEnd === 'ended') setNotice('หยุดวิดีโอแล้ว TikTok รับคำสั่งปิดห้อง LIVE');
        else if (roomEnd === 'no_room') setNotice('หยุดวิดีโอแล้ว ไม่พบห้อง LIVE ที่เปิดอยู่');
        else
          setError('หยุดวิดีโอแล้ว แต่ยังยืนยันการปิดห้อง TikTok ไม่ได้ กรุณาตรวจใน TikTok Shop');
      }
      if (action === 'start') setStatusModalOpen(true);
      void refreshStatus(selectedAccountId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'สั่งงานสตรีมไม่สำเร็จ');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="cyber-live-page">
      <div className="cyber-live-intro">
        <strong>ส่งวิดีโอ MP4 ไปยังปลายทาง LIVE ที่ตั้งค่าไว้</strong>
        <p>
          เลือก MP4 แล้วสร้างห้องเพื่อดึงปลายทางอัตโนมัติ หรือกรอก RTMP ใน “ตั้งค่าบัญชี” สถานะ
          “กำลังส่งสัญญาณ” หมายถึงโปรเซสวิดีโอกำลังทำงาน ระบบยังไม่มีข้อมูลยืนยันว่าห้อง LIVE
          เปิดให้ผู้ชมบน TikTok แล้ว
        </p>
      </div>
      <div className="cyber-live-summary">
        <div>
          <strong>
            {statusUnavailable ? '—' : sessions.filter((item) => item.status === 'live').length}
          </strong>
          <span>กำลังส่งสัญญาณ</span>
        </div>
        <div>
          <strong>{videos.length}</strong>
          <span>วิดีโอที่อัปโหลด</span>
        </div>
        <div>
          <strong>
            {accounts.filter((item) => item.verificationStatus === 'connected').length}
          </strong>
          <span>บัญชีที่เชื่อมต่อ</span>
        </div>
      </div>
      <section className="cyber-panel">
        <div className="cyber-panel-title">
          <span className="cyber-spark">▪</span> เลือกบัญชีและสถานะสตรีม
          <span className="cyber-panel-action">
            <button
              className="cyber-btn default"
              type="button"
              onClick={() => void loadLive()}
              disabled={busy !== ''}
            >
              <RefreshCw size={13} /> รีเฟรช
            </button>
          </span>
        </div>
        <div className="cyber-live-section">
          <label>
            บัญชี TikTok
            <select
              value={selectedAccountId}
              onChange={(event) => setSelectedAccountId(event.target.value)}
            >
              <option value="">เลือกบัญชี</option>
              {accounts.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={item.verificationStatus !== 'connected'}
                >
                  {item.alias}
                  {item.verifiedHandle ? ` (@${item.verifiedHandle})` : ''}
                  {item.verificationStatus !== 'connected' ? ' · ยังไม่เชื่อมต่อ' : ''}
                </option>
              ))}
            </select>
          </label>
          {loading ? (
            <p>กำลังโหลดสถานะจริง…</p>
          ) : !accounts.length ? (
            <p>ยังไม่มีบัญชีที่เชื่อมต่อ กรุณาเพิ่มบัญชีในหน้า Accounts ก่อน</p>
          ) : (
            <div className="cyber-live-state">
              <span
                className={`cyber-badge ${statusUnavailable ? 'dim' : status === 'live' ? 'green' : status === 'failed' ? 'pink' : active ? 'yellow' : 'dim'}`}
              >
                {statusUnavailable ? 'ตรวจสถานะไม่ได้' : statusLabel(status)}
              </span>
              {account?.liveTitle && <span>ชื่อไลฟ์: {account.liveTitle}</span>}
              {session?.videoName && <span>วิดีโอ: {session.videoName}</span>}
              {session?.startedAt && (
                <span>เริ่มส่ง: {new Date(session.startedAt).toLocaleString('th-TH')}</span>
              )}
              {account && (
                <button
                  className="cyber-btn cyan"
                  type="button"
                  onClick={() => setStatusModalOpen(true)}
                >
                  ดูรายละเอียดสถานะ
                </button>
              )}
            </div>
          )}
          {status === 'failed' && !statusUnavailable && (
            <p className="cyber-account-error">{streamErrorText(session?.error)}</p>
          )}
        </div>
      </section>
      <section className="cyber-panel">
        <div className="cyber-panel-title">
          <span className="cyber-spark">▪</span> วิดีโอ MP4
        </div>
        <div className="cyber-live-section">
          <form className="cyber-live-form" onSubmit={uploadVideo}>
            <label>
              เลือกไฟล์จากเครื่อง (สูงสุด 8 GB)
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
          {busy === 'upload' && uploadProgress !== null && (
            <div role="status">
              {uploadProgress < 100
                ? `กำลังอัปโหลด ${uploadProgress}%`
                : 'อัปโหลดครบแล้ว กำลังตรวจและแปลงวิดีโอเป็น H.264/AAC อาจใช้เวลาหลายนาที อย่าปิดหน้านี้'}
            </div>
          )}
          <label>
            วิดีโอที่จะส่ง
            <select
              value={selectedVideoId}
              onChange={(event) =>
                selectedAccountId &&
                setVideoSelection((current) => ({
                  ...current,
                  [selectedAccountId]: event.target.value,
                }))
              }
              disabled={!selectedAccountId || active || busy !== ''}
            >
              <option value="">เลือกวิดีโอ</option>
              {videos.map((video) => (
                <option key={video.id} value={video.id}>
                  {video.name} · {(video.sizeBytes / 1024 / 1024).toFixed(1)} MB
                </option>
              ))}
            </select>
          </label>
          {selectedVideoId && selectedVideoId !== session?.videoId && (
            <div className="cyber-live-video-change">
              <small>วิดีโอที่เลือกยังไม่ถูกบันทึกสำหรับบัญชีนี้</small>
              <button
                className="cyber-btn pink"
                type="button"
                onClick={() => void saveVideoSelection()}
                disabled={!selectedVideoId || active || busy !== ''}
              >
                {busy === 'video' ? 'กำลังบันทึก…' : 'ใช้วิดีโอนี้'}
              </button>
            </div>
          )}
          {videos.length > 0 && (
            <div className="cyber-live-video-list">
              {videos.map((video) => (
                <div key={video.id}>
                  <span>{video.name}</span>
                  <button
                    className="cyber-btn danger"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => void deleteVideo(video)}
                  >
                    {deletingVideoId === video.id ? 'กำลังลบ…' : 'ลบ'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      <section className="cyber-panel">
        <div className="cyber-panel-title">
          <span className="cyber-spark">▪</span> ตั้งชื่อห้อง LIVE
        </div>
        <div className="cyber-live-section">
          <label>
            ชื่อห้องไลฟ์
            <input
              type="text"
              value={liveTitle}
              onChange={(event) => setLiveTitle(event.target.value)}
              maxLength={120}
              placeholder="ใส่ชื่อห้อง LIVE"
              disabled={busy !== '' || active}
            />
          </label>
          {createdRoomId && <span>ห้องที่สร้าง: {createdRoomId}</span>}
          <small>กดเริ่มไลฟ์เพื่อสร้างห้อง ดึงคีย์ และเริ่มส่งวิดีโอในครั้งเดียว</small>
        </div>
      </section>
      {selectedAccountId && (!selectedVideoId || !liveTitle.trim()) && (
        <div className="cyber-live-setup">
          <span>เลือกวิดีโอและตั้งชื่อไลฟ์ก่อนเริ่ม</span>
          <button
            className="cyber-btn cyan"
            type="button"
            onClick={() => onSetup(selectedAccountId)}
          >
            <Settings size={13} /> ตั้งค่าบัญชีและปลายทาง
          </button>
        </div>
      )}
      <section className="cyber-panel">
        <div className="cyber-panel-title">
          <span className="cyber-spark">▪</span> ควบคุมสตรีม
        </div>
        <div className="cyber-live-controls">
          <button
            className="cyber-btn green"
            type="button"
            disabled={!canStart}
            onClick={() => void changeStream('start')}
          >
            <Play size={13} fill="currentColor" />{' '}
            {busy === 'start' ? 'กำลังเริ่ม…' : 'เริ่มส่งสัญญาณจริง'}
          </button>
          <button
            className="cyber-btn danger"
            type="button"
            disabled={
              busy !== '' || (status !== 'starting' && status !== 'live' && !session?.hasOpenRoom)
            }
            onClick={() => void changeStream('stop')}
          >
            <Square size={13} fill="currentColor" /> {busy === 'stop' ? 'กำลังลงไลฟ์…' : 'ลงไลฟ์'}
          </button>
          <span>เริ่มได้เมื่อบัญชีเชื่อมต่อ มีวิดีโอ และตั้งชื่อไลฟ์แล้ว</span>
        </div>
      </section>
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
      {statusModalOpen && account && (
        <div className="cyber-stream-backdrop" onClick={() => setStatusModalOpen(false)}>
          <section
            className="cyber-stream-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cyber-stream-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="cyber-stream-head">
              <h2 id="cyber-stream-title">สถานะการส่งสัญญาณ — {account.alias}</h2>
              <button
                type="button"
                aria-label="ปิดหน้าต่างสถานะ"
                onClick={() => setStatusModalOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="cyber-stream-body">
              <div className="cyber-stream-tags">
                <span
                  className={`cyber-stream-signal ${!statusUnavailable && status === 'live' ? 'is-sending' : ''}`}
                >
                  {statusUnavailable
                    ? '● ไม่ทราบสถานะ'
                    : status === 'live'
                      ? '● SENDING OUT'
                      : `● ${statusLabel(status)}`}
                </span>
                <span>
                  บัญชี: {account.verifiedHandle ? `@${account.verifiedHandle}` : account.alias}
                </span>
              </div>
              <div className="cyber-stream-monitor">
                <div className="cyber-stream-monitor-title">▣ ข้อมูลจากระบบส่งวิดีโอ</div>
                <dl>
                  <div>
                    <dt>สถานะ</dt>
                    <dd>{statusUnavailable ? 'ตรวจสถานะไม่ได้' : statusLabel(status)}</dd>
                  </div>
                  <div>
                    <dt>ไฟล์ MP4</dt>
                    <dd>{session?.videoName ?? 'ยังไม่มีวิดีโอที่บันทึกไว้'}</dd>
                  </div>
                  <div>
                    <dt>เริ่มส่ง</dt>
                    <dd>
                      {session?.startedAt
                        ? new Date(session.startedAt).toLocaleString('th-TH')
                        : 'ยังไม่เริ่มส่ง'}
                    </dd>
                  </div>
                  <div>
                    <dt>ห้อง LIVE ของ TikTok</dt>
                    <dd>{createdRoomId || 'ระบบยังไม่มีข้อมูลยืนยันจาก TikTok'}</dd>
                  </div>
                </dl>
              </div>
              <p className="cyber-stream-explainer">
                “กำลังส่งสัญญาณ” หมายถึงโปรเซสวิดีโอกำลังส่งไปยังปลายทางที่บันทึกไว้
                สถานะนี้ยังไม่ยืนยันว่าผู้ชมเห็น LIVE บน TikTok
              </p>
              <div className="cyber-stream-actions">
                <button
                  className="cyber-btn cyan"
                  type="button"
                  onClick={() => void refreshStatus(selectedAccountId)}
                >
                  <RefreshCw size={13} /> ตรวจสถานะอีกครั้ง
                </button>
                <button
                  className="cyber-btn default"
                  type="button"
                  onClick={() => setStatusModalOpen(false)}
                >
                  ปิด
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
