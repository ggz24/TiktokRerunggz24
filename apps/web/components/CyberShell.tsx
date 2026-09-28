'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import LiveSessionPanel from './LiveSessionPanel';
import {
  CircleCheck,
  LogOut,
  Menu,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShoppingCart,
  Upload,
  X,
} from 'lucide-react';
import '../app/cyber.css';

type Page =
  | 'dashboard'
  | 'accounts'
  | 'live'
  | 'videos'
  | 'playlists'
  | 'products'
  | 'comments'
  | 'analytics'
  | 'sales'
  | 'logs'
  | 'settings';
const primary: { id: Page; mark: string; label: string }[] = [
  { id: 'dashboard', mark: '[#]', label: 'บัญชีไลฟ์' },
  { id: 'videos', mark: '[>]', label: 'คลังวิดีโอ' },
  { id: 'comments', mark: '[~]', label: 'ตอบอัตโนมัติ' },
  { id: 'analytics', mark: '[%]', label: 'สถิติ AI' },
  { id: 'sales', mark: '[฿]', label: 'ยอดขาย' },
];
const workspace: { id: Page; mark: string; label: string }[] = [
  { id: 'accounts', mark: '[A]', label: 'Accounts' },
  { id: 'live', mark: '[L]', label: 'Live Session' },
  { id: 'playlists', mark: '[P]', label: 'Playlist' },
  { id: 'products', mark: '[$]', label: 'Product Set' },
  { id: 'logs', mark: '[!]', label: 'Logs' },
  { id: 'settings', mark: '[*]', label: 'Settings' },
];
const names: Record<Page, string> = {
  dashboard: 'บัญชีไลฟ์',
  accounts: 'บัญชีทั้งหมด',
  live: 'Live Session',
  videos: 'คลังวิดีโอ',
  playlists: 'Playlist',
  products: 'Product Set',
  comments: 'ตอบอัตโนมัติ',
  analytics: 'สถิติการตอบของ AI',
  sales: 'ยอดขายไลฟ์',
  logs: 'บันทึกระบบ',
  settings: 'ตั้งค่าระบบ',
};
const sampleVideos = [
  { name: 'demo-product-01.mp4', size: '32.4 MB', code: '01' },
  { name: 'demo-loop-02.mp4', size: '48.2 MB', code: '02' },
  { name: 'demo-promo-03.mp4', size: '21.8 MB', code: '03' },
  { name: 'demo-intro-04.mp4', size: '16.7 MB', code: '04' },
];

type SavedAccount = {
  id: string;
  alias: string;
  liveTitle?: string | null;
  claimedHandle?: string | null;
  verifiedHandle?: string | null;
  avatarUrl?: string | null;
  verifiedAt?: string | null;
  verificationStatus: 'connected' | 'pending_verification' | 'disconnected';
  probe: 'responded' | 'failed' | 'not_run';
  probeHttpStatus?: number | null;
  createdAt: string;
};

type StreamVideo = { id: string; name: string; sizeBytes: number };
type StreamSession = {
  accountId: string;
  status: 'idle' | 'starting' | 'live' | 'stopping' | 'failed';
  hasRtmpConfig: boolean;
  videoId?: string | null;
  videoName?: string | null;
};

function Btn({
  children,
  onClick,
  tone = 'default',
  className = '',
  disabled = false,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'pink' | 'green' | 'cyan' | 'danger';
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      className={'cyber-btn ' + tone + ' ' + className}
      onClick={onClick}
      disabled={disabled}
      type={type}
    >
      {children}
    </button>
  );
}
function Badge({
  children,
  tone = 'cyan',
}: {
  children: React.ReactNode;
  tone?: 'cyan' | 'green' | 'pink' | 'dim' | 'yellow';
}) {
  return <span className={'cyber-badge ' + tone}>{children}</span>;
}
function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="cyber-panel">
      <div className="cyber-panel-title">
        <span className="cyber-spark">▪</span>
        {title}
        {action && <span className="cyber-panel-action">{action}</span>}
      </div>
      {children}
    </section>
  );
}

export default function CyberShell({ section, username }: { section: Page; username: string }) {
  const router = useRouter();
  const [clock, setClock] = useState('--:--:--');
  const [mobile, setMobile] = useState(false);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState('');
  const [tab, setTab] = useState('ตอบอัตโนมัติ');
  const [search] = useState('');
  const [autoReply, setAutoReply] = useState(true);
  const [welcome, setWelcome] = useState(true);
  const [systemStatus, setSystemStatus] = useState<'checking' | 'ready' | 'degraded' | 'offline'>(
    'checking',
  );
  const [dependencies, setDependencies] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState('');
  const [accountAlias, setAccountAlias] = useState('');
  const [accountImportMode, setAccountImportMode] = useState<'sessionid' | 'curl'>('sessionid');
  const [accountSessionId, setAccountSessionId] = useState('');
  const [accountCurl, setAccountCurl] = useState('');
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [accountFormError, setAccountFormError] = useState('');
  const [verifyingAccountId, setVerifyingAccountId] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<SavedAccount | null>(null);
  const [accountLiveTitle, setAccountLiveTitle] = useState('');
  const [settingsSubmitting, setSettingsSubmitting] = useState(false);
  const [accountDeleting, setAccountDeleting] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [streamVideos, setStreamVideos] = useState<StreamVideo[]>([]);
  const [streamSession, setStreamSession] = useState<StreamSession | null>(null);
  const [streamVideoId, setStreamVideoId] = useState('');
  const [streamUrl, setStreamUrl] = useState('');
  const [streamKey, setStreamKey] = useState('');
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamBusy, setStreamBusy] = useState<'config' | 'video' | ''>('');
  const [streamSetupError, setStreamSetupError] = useState('');
  const [streamSetupNotice, setStreamSetupNotice] = useState('');
  const [startingAccountId, setStartingAccountId] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ accountId: string; message: string } | null>(null);
  const streamLoadGeneration = useRef(0);
  useEffect(() => {
    const update = () => setClock(new Date().toLocaleTimeString('th-TH', { hour12: false }));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    fetch('/api/system/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (active) {
          setSystemStatus(data.status);
          setDependencies(data.dependencies ?? {});
        }
      })
      .catch(() => {
        if (active) setSystemStatus('offline');
      });
    return () => {
      active = false;
    };
  }, []);
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError('');
    try {
      const response = await fetch('/api/accounts', { cache: 'no-store' });
      if (!response.ok) throw new Error('load failed');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) {
        throw new Error('invalid response');
      }
      setAccounts(data.items as SavedAccount[]);
    } catch {
      setAccounts([]);
      setAccountsError('โหลดบัญชีไม่สำเร็จ กรุณาลองอีกครั้ง');
    } finally {
      setAccountsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);
  const notify = (value: string) => {
    setToast(value);
    window.setTimeout(() => setToast(''), 3500);
  };
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }
  function closeModal() {
    streamLoadGeneration.current += 1;
    setModal('');
    setAccountAlias('');
    setAccountSessionId('');
    setAccountCurl('');
    setAccountFormError('');
    setAccountLiveTitle('');
    setSelectedAccount(null);
    setStreamVideos([]);
    setStreamSession(null);
    setStreamVideoId('');
    setStreamUrl('');
    setStreamKey('');
    setStreamSetupError('');
    setStreamSetupNotice('');
  }
  function openAccountSettings(account: SavedAccount) {
    const generation = ++streamLoadGeneration.current;
    setSelectedAccount(account);
    setAccountAlias(account.alias);
    setAccountLiveTitle(account.liveTitle ?? '');
    setAccountFormError('');
    setStreamVideos([]);
    setStreamSession(null);
    setStreamVideoId('');
    setStreamUrl('');
    setStreamKey('');
    setStreamSetupError('');
    setStreamSetupNotice('');
    setModal('ตั้งค่าบัญชี');
    void loadAccountStream(account.id, generation);
  }
  async function startAccountStream(account: SavedAccount) {
    if (startingAccountId) return;
    setStartingAccountId(account.id);
    setStartError(null);
    try {
      const statusResponse = await fetch(
        `/api/live/sessions/${encodeURIComponent(account.id)}/status`,
        { cache: 'no-store' },
      );
      if (!statusResponse.ok) throw new Error('ตรวจการตั้งค่าสตรีมไม่สำเร็จ');
      const statusData: unknown = await statusResponse.json();
      if (
        !statusData ||
        typeof statusData !== 'object' ||
        !('item' in statusData) ||
        !statusData.item
      )
        throw new Error('อ่านการตั้งค่าสตรีมไม่สำเร็จ');
      const session = statusData.item as StreamSession;
      if (!session.hasRtmpConfig || !session.videoId) {
        openAccountSettings(account);
        setStreamSetupNotice('เลือกวิดีโอและบันทึกปลายทางสตรีมก่อนเริ่มครั้งแรก');
        return;
      }
      if (session.status === 'starting' || session.status === 'live') {
        router.push(`/live?accountId=${encodeURIComponent(account.id)}&status=1`);
        return;
      }
      const response = await fetch(`/api/live/sessions/${encodeURIComponent(account.id)}/start`, {
        method: 'POST',
      });
      if (!response.ok) {
        if (response.status === 409) throw new Error('สถานะสตรีมเปลี่ยนไป กรุณาลองอีกครั้ง');
        throw new Error('เริ่มส่งสัญญาณไม่สำเร็จ กรุณาตรวจปลายทางและวิดีโอ');
      }
      router.push(`/live?accountId=${encodeURIComponent(account.id)}&status=1`);
    } catch (error) {
      setStartError({
        accountId: account.id,
        message: error instanceof Error ? error.message : 'เริ่มส่งสัญญาณไม่สำเร็จ',
      });
    } finally {
      setStartingAccountId(null);
    }
  }
  async function saveStreamConfig() {
    if (!selectedAccount || streamBusy || streamLoading) return;
    if (!streamVideoId || !streamUrl.trim() || !streamKey.trim()) {
      setStreamSetupError('เลือกวิดีโอและกรอก RTMP URL กับ stream key ให้ครบ');
      return;
    }
    setStreamBusy('config');
    setStreamSetupError('');
    setStreamSetupNotice('');
    try {
      const response = await fetch(
        `/api/live/sessions/${encodeURIComponent(selectedAccount.id)}/config`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rtmpUrl: streamUrl.trim(),
            streamKey: streamKey.trim(),
            videoId: streamVideoId,
          }),
        },
      );
      if (!response.ok) {
        if (response.status === 409) throw new Error('กรุณาหยุดสตรีมก่อนเปลี่ยนปลายทาง');
        throw new Error('บันทึกปลายทางไม่สำเร็จ กรุณาตรวจ RTMP URL, key และวิดีโอ');
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('item' in data) || !data.item)
        throw new Error('อ่านผลการบันทึกไม่สำเร็จ');
      setStreamSession(data.item as StreamSession);
      setStreamUrl('');
      setStreamKey('');
      setStreamSetupNotice('บันทึกปลายทางแล้ว กลับไปกดเริ่มจากการ์ดบัญชีได้');
    } catch (error) {
      setStreamSetupError(error instanceof Error ? error.message : 'บันทึกปลายทางไม่สำเร็จ');
    } finally {
      setStreamBusy('');
    }
  }
  async function saveStreamVideo() {
    if (!selectedAccount || !streamVideoId || streamBusy || streamLoading) return;
    setStreamBusy('video');
    setStreamSetupError('');
    try {
      const response = await fetch(
        `/api/live/sessions/${encodeURIComponent(selectedAccount.id)}/video`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: streamVideoId }),
        },
      );
      if (!response.ok) throw new Error('เปลี่ยนวิดีโอไม่สำเร็จ กรุณาหยุดสตรีมก่อน');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('item' in data) || !data.item)
        throw new Error('อ่านผลการบันทึกไม่สำเร็จ');
      setStreamSession(data.item as StreamSession);
      setStreamSetupNotice('เปลี่ยนวิดีโอแล้ว');
    } catch (error) {
      setStreamSetupError(error instanceof Error ? error.message : 'เปลี่ยนวิดีโอไม่สำเร็จ');
    } finally {
      setStreamBusy('');
    }
  }
  async function loadAccountStream(accountId: string, generation: number) {
    setStreamLoading(true);
    try {
      const [videoResponse, statusResponse] = await Promise.all([
        fetch('/api/live/videos', { cache: 'no-store' }),
        fetch(`/api/live/sessions/${encodeURIComponent(accountId)}/status`, { cache: 'no-store' }),
      ]);
      if (!videoResponse.ok || !statusResponse.ok) throw new Error('โหลดค่าการส่งสัญญาณไม่สำเร็จ');
      const videos: unknown = await videoResponse.json();
      const status: unknown = await statusResponse.json();
      if (
        !videos ||
        typeof videos !== 'object' ||
        !('items' in videos) ||
        !Array.isArray(videos.items) ||
        !status ||
        typeof status !== 'object' ||
        !('item' in status) ||
        !status.item
      )
        throw new Error('โหลดค่าการส่งสัญญาณไม่สำเร็จ');
      if (generation !== streamLoadGeneration.current) return;
      const items = videos.items as StreamVideo[];
      const item = status.item as StreamSession;
      setStreamVideos(items);
      setStreamSession(item);
      setStreamVideoId(item.videoId ?? items[0]?.id ?? '');
      setStreamSetupError('');
    } catch {
      if (generation === streamLoadGeneration.current) {
        setStreamSetupError('โหลดค่าการส่งสัญญาณไม่สำเร็จ กรุณาปิดแล้วเปิดตั้งค่าบัญชีอีกครั้ง');
      }
    } finally {
      if (generation === streamLoadGeneration.current) setStreamLoading(false);
    }
  }
  function confirmAccountDeletion(account: SavedAccount) {
    setSelectedAccount(account);
    setAccountFormError('');
    setModal('ลบบัญชี');
  }
  async function saveAccountSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAccount || settingsSubmitting) return;
    const alias = accountAlias.trim();
    const liveTitle = accountLiveTitle.trim();
    if (!alias || alias.length > 80 || liveTitle.length > 120) {
      setAccountFormError('ชื่อเรียกต้องมี 1–80 ตัวอักษร และชื่อไลฟ์ไม่เกิน 120 ตัวอักษร');
      return;
    }
    setSettingsSubmitting(true);
    setAccountFormError('');
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(selectedAccount.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias, liveTitle }),
      });
      if (response.status === 404) throw new Error('ไม่พบบัญชีนี้ กรุณารีเฟรชรายการ');
      if (response.status === 401) throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
      if (response.status === 400) throw new Error('ข้อมูลตั้งค่าไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง');
      if (!response.ok) throw new Error('บันทึกการตั้งค่าไม่สำเร็จ กรุณาลองอีกครั้ง');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('item' in data)) {
        throw new Error('บันทึกการตั้งค่าไม่สำเร็จ กรุณาลองอีกครั้ง');
      }
      const item = data.item as SavedAccount;
      setAccounts((current) => current.map((account) => (account.id === item.id ? item : account)));
      closeModal();
      notify('บันทึกการตั้งค่าบัญชีแล้ว');
    } catch (error) {
      setAccountFormError(error instanceof Error ? error.message : 'บันทึกการตั้งค่าไม่สำเร็จ');
    } finally {
      setSettingsSubmitting(false);
    }
  }
  async function deleteAccount() {
    if (!selectedAccount || accountDeleting) return;
    setAccountDeleting(true);
    setAccountFormError('');
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(selectedAccount.id)}`, {
        method: 'DELETE',
      });
      if (response.status === 404) throw new Error('ไม่พบบัญชีนี้ กรุณารีเฟรชรายการ');
      if (response.status === 401) throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
      if (response.status === 409) throw new Error('บัญชีนี้กำลังสตรีม กรุณาหยุดสตรีมก่อนลบ');
      if (!response.ok) throw new Error('ลบบัญชีไม่สำเร็จ กรุณาลองอีกครั้ง');
      setAccounts((current) => current.filter((account) => account.id !== selectedAccount.id));
      closeModal();
      notify('ลบบัญชีออกจากระบบแล้ว');
    } catch (error) {
      setAccountFormError(error instanceof Error ? error.message : 'ลบบัญชีไม่สำเร็จ');
    } finally {
      setAccountDeleting(false);
    }
  }
  async function saveAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accountSubmitting) return;
    if (
      !accountAlias.trim() ||
      !(accountImportMode === 'sessionid' ? accountSessionId : accountCurl).trim()
    ) {
      setAccountFormError('กรอกชื่อเรียกและข้อมูล session ก่อนบันทึก');
      return;
    }
    setAccountSubmitting(true);
    setAccountFormError('');
    try {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: accountAlias.trim(),
          liveTitle: accountLiveTitle.trim(),
          ...(accountImportMode === 'sessionid'
            ? { sessionid: accountSessionId.trim() }
            : { curl: accountCurl }),
        }),
      });
      if (response.status === 422) {
        throw new Error(
          'TikTok ไม่ยืนยัน session นี้ ลองใช้ cURL จาก DevTools หาก sessionid อย่างเดียวไม่พอ',
        );
      }
      if (response.status === 400) {
        throw new Error('ข้อมูล session ไม่ถูกต้อง กรุณาตรวจค่าที่วางอีกครั้ง');
      }
      if (response.status === 503) {
        throw new Error('ระบบบัญชียังไม่พร้อม กรุณาลองอีกครั้งเมื่อบริการกลับมาทำงาน');
      }
      if (response.status === 401) {
        throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
      }
      if (!response.ok) throw new Error('บันทึกไม่สำเร็จ กรุณาลองอีกครั้ง');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('item' in data)) {
        throw new Error('invalid response');
      }
      // Never keep the pasted session in the form after a successful save.
      setAccountCurl('');
      setAccountSessionId('');
      setAccountAlias('');
      closeModal();
      notify('เชื่อมต่อบัญชี TikTok แล้ว');
      void loadAccounts();
    } catch (error) {
      // Only display our own fixed text; a server response could reflect pasted cURL.
      setAccountFormError(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setAccountSubmitting(false);
    }
  }
  async function verifyAccount(id: string) {
    if (verifyingAccountId) return;
    setVerifyingAccountId(id);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(id)}/verify`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('verify failed');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('item' in data)) {
        throw new Error('invalid response');
      }
      const item = data.item as SavedAccount;
      setAccounts((current) => current.map((account) => (account.id === id ? item : account)));
      notify(
        item.verificationStatus === 'connected'
          ? 'บัญชีเชื่อมต่อแล้ว'
          : 'session หมดอายุหรือใช้ไม่ได้',
      );
    } catch {
      notify('ตรวจการเชื่อมต่อไม่สำเร็จ กรุณาลองอีกครั้ง');
    } finally {
      setVerifyingAccountId(null);
    }
  }
  function savedAccountCard(account: SavedAccount) {
    const connected = account.verificationStatus === 'connected';
    const disconnected = account.verificationStatus === 'disconnected';
    return (
      <article className="cyber-account-card cyber-saved-card" key={account.id}>
        <div className="cyber-card-head">
          <span>
            <i className="cyber-square" /> บัญชีที่เพิ่ม
          </span>
          <Badge tone={connected ? 'green' : disconnected ? 'pink' : 'yellow'}>
            {connected ? 'เชื่อมต่อแล้ว' : disconnected ? 'session ใช้ไม่ได้' : 'รอตรวจบัญชี'}
          </Badge>
        </div>
        <div className="cyber-card-body">
          <div className="cyber-avatar avatar-0">
            {connected && account.avatarUrl ? (
              <img
                src={account.avatarUrl}
                alt={`รูปบัญชี ${account.verifiedHandle ?? ''}`}
                referrerPolicy="no-referrer"
              />
            ) : (
              <>
                <span>▶</span>
                <small>บัญชี</small>
              </>
            )}
          </div>
          <div className="cyber-account-info">
            <div className="cyber-account-name">
              <span className="cyber-initial">{account.alias.charAt(0).toUpperCase()}</span>
              <strong>{account.alias}</strong>
            </div>
            <div className="cyber-handle">
              {connected && account.verifiedHandle
                ? `@${account.verifiedHandle} · จาก TikTok`
                : account.claimedHandle
                  ? `ชื่อที่อ้างจาก cURL: ${account.claimedHandle}`
                  : 'ยังไม่ทราบชื่อบัญชี TikTok'}
            </div>
            <div className="cyber-chip-row">
              <Badge tone={connected ? 'green' : disconnected ? 'pink' : 'yellow'}>
                {connected
                  ? 'อ่านข้อมูลบัญชีจาก session สำเร็จ'
                  : disconnected
                    ? 'session ไม่ผ่านการตรวจล่าสุด'
                    : 'ตรวจ session อีกครั้งได้'}
              </Badge>
            </div>
            {connected && account.verifiedAt && (
              <div className="cyber-account-note">
                ตรวจล่าสุด {new Date(account.verifiedAt).toLocaleString('th-TH')}
              </div>
            )}
            {account.liveTitle && (
              <div className="cyber-account-note">ชื่อไลฟ์เริ่มต้น: {account.liveTitle}</div>
            )}
          </div>
        </div>
        <div className="cyber-card-actions">
          <Btn
            tone="cyan"
            onClick={() => void verifyAccount(account.id)}
            disabled={verifyingAccountId !== null}
          >
            <RefreshCw size={13} />{' '}
            {verifyingAccountId === account.id ? 'กำลังตรวจ…' : 'ตรวจการเชื่อมต่อ'}
          </Btn>
          <Btn
            tone="green"
            onClick={() => void startAccountStream(account)}
            disabled={!connected || startingAccountId !== null}
          >
            <Play size={12} fill="currentColor" />{' '}
            {startingAccountId === account.id ? 'กำลังเริ่ม…' : 'เริ่มส่งสัญญาณ'}
          </Btn>
          <Btn
            onClick={() =>
              router.push(`/live?accountId=${encodeURIComponent(account.id)}&status=1`)
            }
          >
            สถานะ
          </Btn>
          <Btn onClick={() => openAccountSettings(account)}>
            <Settings size={13} /> ตั้งค่า
          </Btn>
          <Btn tone="danger" onClick={() => confirmAccountDeletion(account)}>
            ลบ
          </Btn>
          <span className="cyber-account-note">
            {connected
              ? 'เลือกคลิปและดึงปลายทางอัตโนมัติในหน้า Live Session หรือกรอก RTMP ในตั้งค่าบัญชี'
              : 'กรุณาตรวจการเชื่อมต่อก่อนเข้าไลฟ์'}
          </span>
          {startError?.accountId === account.id && (
            <span className="cyber-account-error" role="alert">
              {startError.message}
            </span>
          )}
        </div>
      </article>
    );
  }
  function accountCard(name: string, handle: string, idx: number) {
    return (
      <article className="cyber-account-card" key={name}>
        <div className="cyber-card-head">
          <span>
            <i className="cyber-square" /> ข้อมูลตัวอย่าง
          </span>
          <span className="cyber-card-head-right">
            <Badge tone="dim">MOCK ONLY</Badge>
          </span>
        </div>
        <div className="cyber-card-body">
          <div className={'cyber-avatar avatar-' + idx}>
            <span>▶</span>
            <small>DEMO {idx + 1}</small>
          </div>
          <div className="cyber-account-info">
            <div className="cyber-account-name">
              <span className="cyber-initial">{name.charAt(0)}</span>
              <strong>{name}</strong>
            </div>
            <div className="cyber-handle">{handle}</div>
            <div className="cyber-chip-row">
              <Badge tone="cyan">▣ {handle}</Badge>
              <Badge tone="dim">▥ HD</Badge>
              <Badge tone="dim">▣ วิดีโอตัวอย่าง</Badge>
            </div>
            <div className="cyber-chip-row">
              <Badge tone="dim">● คอมเมนต์ตัวอย่าง</Badge>
              <Badge tone="dim">▣ แชทตัวอย่าง</Badge>
              <Badge tone="dim">▣ AI ตัวอย่าง</Badge>
              <Badge tone="dim">⚡ MOCK</Badge>
            </div>
          </div>
        </div>
        <div className="cyber-card-actions">
          <Btn tone="green" disabled>
            <Play size={12} fill="currentColor" /> เริ่มไลฟ์
          </Btn>
          <Btn disabled>สถานะ</Btn>
          <Btn disabled>
            <ShoppingCart size={13} /> เพิ่มสินค้า
          </Btn>
          <Btn disabled>
            <Settings size={13} /> ตั้งค่า
          </Btn>
          <Btn disabled>แก้ไข</Btn>
          <Btn tone="danger" disabled>
            ลบ
          </Btn>
        </div>
      </article>
    );
  }
  function accountView() {
    return (
      <>
        <div className="cyber-toolbar">
          <Btn tone="pink" onClick={() => setModal('เพิ่มบัญชี')}>
            <Plus size={14} /> เพิ่มบัญชี
          </Btn>
          <Btn onClick={() => void loadAccounts()}>
            <RefreshCw size={13} /> รีเฟรชบัญชี
          </Btn>
          <Btn onClick={() => router.push('/live')}>
            <Upload size={13} /> อัปโหลดวิดีโอ
          </Btn>
          <Btn onClick={() => setModal('ภาพรวมทุกบัญชี')}>▣ ภาพรวม</Btn>
          <Btn onClick={() => setModal('Telegram')}>▣ Telegram</Btn>
        </div>
        <div className="cyber-account-section-head">
          <h2>บัญชีที่เพิ่ม</h2>
          <span>ระบบอ่านตัวตนจาก TikTok และแสดงผลการเชื่อมต่อจริง</span>
        </div>
        {accountsError && (
          <p className="cyber-account-error" role="alert">
            {accountsError}
          </p>
        )}
        {accountsLoading ? (
          <p className="cyber-account-empty">กำลังโหลดบัญชี…</p>
        ) : accounts.length ? (
          <div className="cyber-account-grid">{accounts.map(savedAccountCard)}</div>
        ) : (
          <p className="cyber-account-empty">ยังไม่มีบัญชีที่เพิ่มด้วย cURL</p>
        )}
        <div className="cyber-account-section-head cyber-demo-section">
          <h2>ข้อมูลตัวอย่าง</h2>
          <span>ใช้ดูหน้าตาเว็บเท่านั้น</span>
        </div>
        <div className="cyber-account-grid">
          {accountCard('Demo Shop A', '@demo_shop_a', 0)}
          {section === 'accounts' && accountCard('Demo Shop B', '@demo_shop_b', 1)}
        </div>
      </>
    );
  }
  function videoView() {
    return (
      <>
        <Panel title="อัปโหลดวิดีโอสำหรับไลฟ์">
          <div className="cyber-drop" onClick={() => router.push('/live')}>
            <Upload size={22} />
            <strong>ไปหน้า Live Session เพื่ออัปโหลด MP4</strong>
            <small>อัปโหลดวิดีโอ MP4 แล้วเลือกใช้กับบัญชีที่ต้องการ</small>
          </div>
          <div className="cyber-small-center">สูงสุด 512 MB ต่อไฟล์</div>
        </Panel>
        <Panel title="วิดีโอในคลัง">
          <div className="cyber-video-grid">
            {sampleVideos
              .filter((v) => v.name.includes(search.toLowerCase()))
              .map((v) => (
                <div className="cyber-video-card" key={v.name}>
                  <div className="cyber-video-thumb">
                    <span className="cyber-play">▶</span>
                    <span className="cyber-mp4">MP4</span>
                    <small>{v.code}</small>
                  </div>
                  <div className="cyber-video-meta">
                    <strong>{v.name}</strong>
                    <small>{v.size}</small>
                    <Btn onClick={() => notify('วิดีโอตัวอย่างไม่ได้ถูกลบ')}>ลบ</Btn>
                  </div>
                </div>
              ))}
          </div>
        </Panel>
      </>
    );
  }
  function commentsView() {
    return (
      <>
        <Panel title="ตั้งค่าการตอบอัตโนมัติ">
          <div className="cyber-inline">
            <label>
              เลือกบัญชี{' '}
              <select>
                <option>Demo Shop A</option>
                <option>Demo Shop B</option>
              </select>
            </label>
            <Btn tone="pink" onClick={() => notify('บันทึกการตั้งค่าตัวอย่างแล้ว')}>
              ▣ บันทึกการตั้งค่า
            </Btn>
          </div>
          <div className="cyber-tabs">
            {[
              'ทั่วไป',
              'ตัวเลือกไลฟ์',
              'สินค้า',
              'อัตโนมัติ',
              'ตอบอัตโนมัติ',
              'AI ช่วยตอบ',
              'สถิติ & คอมเมนต์',
            ].map((t) => (
              <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>
                {t}
              </button>
            ))}
          </div>
          <div className="cyber-form-section">
            <label className="cyber-check">
              <input
                type="checkbox"
                checked={autoReply}
                onChange={(e) => setAutoReply(e.target.checked)}
              />{' '}
              💬 ตอบคอมเมนต์อัตโนมัติตามคำที่ดักจับ
            </label>
            <p>เมื่อมีคอมเมนต์ตรงกับคำที่กำหนด ระบบจะส่งคำตอบกลับในไลฟ์</p>
            <div className="cyber-empty-rule">
              ยังไม่มีกฎตอบในข้อมูลตัวอย่าง{' '}
              <Btn onClick={() => setModal('เพิ่มกฎตอบ')}>+ เพิ่มกฎตอบ</Btn>
            </div>
            <label className="cyber-check">
              <input
                type="checkbox"
                checked={welcome}
                onChange={(e) => setWelcome(e.target.checked)}
              />{' '}
              👋 ทักทายคนเข้าไลฟ์
            </label>
            <p>ตั้งข้อความทักทายโดยใช้ {'{user}'} แทนชื่อผู้เข้าชม</p>
            <textarea defaultValue={'ยินดีต้อนรับ {user} เข้าสู่ไลฟ์'} aria-label="ข้อความทักทาย" />
            <h3>🛡 กันสแปม</h3>
            <div className="cyber-input-grid">
              <label>
                เว้นจังหวะ (วินาที)
                <input type="number" defaultValue="4" min="1" />
              </label>
              <label>
                กันตอบซ้ำ (วินาที)
                <input type="number" defaultValue="30" min="1" />
              </label>
              <label>
                สูงสุดต่อนาที
                <input type="number" defaultValue="12" min="1" />
              </label>
            </div>
          </div>
        </Panel>
      </>
    );
  }
  function analyticsView() {
    return (
      <>
        <div className="cyber-section-summary">
          <label>
            เลือกบัญชี{' '}
            <select>
              <option>Demo Shop A</option>
              <option>Demo Shop B</option>
            </select>
          </label>
          <Btn onClick={() => notify('แสดงข้อมูลตัวอย่างล่าสุดแล้ว')}>
            <RefreshCw size={13} /> รีเฟรช
          </Btn>
        </div>
        <div className="cyber-metrics">
          <div>
            <strong>24</strong>
            <span>AI ตอบทั้งหมด</span>
          </div>
          <div>
            <strong>23</strong>
            <span>สำเร็จ</span>
          </div>
          <div>
            <strong>1</strong>
            <span>รอตรวจสอบ</span>
          </div>
        </div>
        <div className="cyber-columns">
          <Panel title="คำถามยอดฮิต">
            <div className="cyber-list">
              {[
                ['ราคาเท่าไร', '8'],
                ['มีสินค้าอะไรบ้าง', '6'],
                ['จัดส่งกี่วัน', '4'],
                ['วิธีสั่งซื้อ', '3'],
              ].map(([t, n]) => (
                <div key={t}>
                  <span>{t}</span>
                  <Badge tone="cyan">{n}</Badge>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="รายการล่าสุด">
            <div className="cyber-list">
              {[
                'ถามเรื่องสินค้า → AI ตอบแล้ว',
                'ถามเรื่องราคา → AI ตอบแล้ว',
                'คำถามใหม่ → รอตรวจสอบ',
              ].map((t, i) => (
                <div key={t}>
                  <span>{t}</span>
                  <Badge tone={i === 2 ? 'yellow' : 'green'}>{i === 2 ? 'รอ' : 'สำเร็จ'}</Badge>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </>
    );
  }
  function genericView() {
    if (section === 'sales')
      return (
        <Panel title="ยอดขายไลฟ์ — รวมทุกบัญชีที่กำลังไลฟ์">
          <div className="cyber-empty">
            <ShoppingCart size={30} />
            <strong>ยังไม่มีบัญชีที่กำลังไลฟ์</strong>
            <small>ยอดขายจะแสดงเมื่อเชื่อม Live Stats และข้อมูลสินค้า</small>
            <Btn onClick={() => notify('แสดงข้อมูลตัวอย่างล่าสุดแล้ว')}>⟳ รีเฟรชยอด</Btn>
          </div>
        </Panel>
      );
    if (section === 'playlists')
      return (
        <Panel title="เพลย์ลิสต์">
          <div className="cyber-row">
            <span>▶ โปรโมชันชุด A</span>
            <Badge tone="green">2 วิดีโอ</Badge>
            <Btn onClick={() => setModal('เพลย์ลิสต์')}>ดูรายการ</Btn>
          </div>
          <div className="cyber-row">
            <span>▶ สินค้าใหม่</span>
            <Badge tone="yellow">ร่าง</Badge>
            <Btn onClick={() => setModal('เพลย์ลิสต์')}>ดูรายการ</Btn>
          </div>
        </Panel>
      );
    if (section === 'products')
      return (
        <Panel title="ชุดสินค้า">
          <div className="cyber-row">
            <span>▣ ชุดทดลอง A</span>
            <Badge tone="green">3 รายการ</Badge>
            <Btn onClick={() => setModal('ชุดสินค้า')}>ดูรายการ</Btn>
          </div>
          <div className="cyber-row">
            <span>▣ ชุดทดลอง B</span>
            <Badge tone="yellow">ร่าง</Badge>
            <Btn onClick={() => setModal('ชุดสินค้า')}>ดูรายการ</Btn>
          </div>
          <p className="cyber-hint">
            พร้อมเชื่อม Search Product, Add Product และ Pin Product หลังยืนยัน endpoint
          </p>
        </Panel>
      );
    if (section === 'logs')
      return (
        <Panel title="บันทึกกิจกรรม">
          <div className="cyber-row">
            <span>09:32 · ซิงก์รายการสินค้า</span>
            <Badge tone="green">สำเร็จ</Badge>
          </div>
          <div className="cyber-row">
            <span>09:20 · สร้างเพลย์ลิสต์ตัวอย่าง</span>
            <Badge tone="green">สำเร็จ</Badge>
          </div>
          <div className="cyber-row">
            <span>08:55 · ตรวจสอบบัญชีตัวอย่าง B</span>
            <Badge tone="yellow">รอตรวจสอบ</Badge>
          </div>
        </Panel>
      );
    return (
      <Panel title="การเชื่อมต่อระบบ">
        <div className="cyber-row">
          <span>▣ PostgreSQL · น็อต</span>
          <Badge tone={dependencies.postgres === 'ready' ? 'green' : 'yellow'}>
            {dependencies.postgres === 'ready' ? 'เชื่อมต่อแล้ว' : 'รอเชื่อม'}
          </Badge>
        </div>
        <div className="cyber-row">
          <span>▣ Redis · น็อต</span>
          <Badge tone={dependencies.redis === 'ready' ? 'green' : 'yellow'}>
            {dependencies.redis === 'ready' ? 'เชื่อมต่อแล้ว' : 'รอเชื่อม'}
          </Badge>
        </div>
        <div className="cyber-row">
          <span>▣ Worker heartbeat · น็อต</span>
          <Badge tone={dependencies.worker === 'ready' ? 'green' : 'yellow'}>
            {dependencies.worker === 'ready' ? 'ทำงาน' : 'รอเชื่อม'}
          </Badge>
        </div>
        <div className="cyber-row">
          <span>▣ Prisma Migration v2 · โอ๊ต</span>
          <Badge tone="yellow">รอเชื่อม</Badge>
        </div>
        <div className="cyber-row">
          <span>▣ TikTok API · ซี</span>
          <Badge tone="yellow">รอยืนยัน Endpoint</Badge>
        </div>
        <div className="cyber-row">
          <span>▣ Comment / Chat Contract · ภูมิ</span>
          <Badge tone="yellow">รอยืนยัน</Badge>
        </div>
        <div className="cyber-row">
          <span>▣ บัญชีผู้ดูแลระบบ</span>
          <Badge tone="green">เปิดใช้</Badge>
        </div>
      </Panel>
    );
  }
  return (
    <div className="cyber-shell">
      <aside className={'cyber-sidebar ' + (mobile ? 'mobile-open' : '')}>
        <div className="cyber-brand">
          <span className="cyber-brand-blocks">
            <i />
            <i />
          </span>
          <div>
            <strong>LIVE HUB</strong>
            <small>TEAM MGR</small>
          </div>
          <button className="cyber-mobile-close" onClick={() => setMobile(false)}>
            <X size={17} />
          </button>
        </div>
        <div className="cyber-sidebar-scroll">
          <nav className="cyber-nav">
            {primary.map((item) => (
              <Link
                className={'cyber-nav-item ' + (section === item.id ? 'active' : '')}
                href={'/' + item.id}
                key={item.id}
                onClick={() => setMobile(false)}
              >
                <b>{item.mark}</b> {item.label}
              </Link>
            ))}
          </nav>
          <div className="cyber-nav-divider">WORKSPACE</div>
          <nav className="cyber-nav cyber-secondary-nav">
            {workspace.map((item) => (
              <Link
                className={'cyber-nav-item ' + (section === item.id ? 'active' : '')}
                href={'/' + item.id}
                key={item.id}
                onClick={() => setMobile(false)}
              >
                <b>{item.mark}</b> {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="cyber-foot">
          <div className="cyber-clock-card">
            <div className="cyber-clock-art">✦</div>
            <div>
              <strong>{clock.slice(0, 5)}</strong>
              <small>บอทพักผ่อน 💤</small>
            </div>
          </div>
          <div className="cyber-foot-ready">
            ■ {systemStatus === 'ready' ? 'บริการหลัก: พร้อม' : 'บริการหลัก: รอเชื่อม'}
          </div>
          <div className="cyber-theme-swatches">
            <span />
            <span />
            <span />
          </div>
          <small>v0.1.0 · LIVE HUB</small>
        </div>
      </aside>
      {mobile && <div className="cyber-backdrop" onClick={() => setMobile(false)} />}
      <div className="cyber-main">
        <header className="cyber-topbar">
          <button className="cyber-menu" onClick={() => setMobile(true)}>
            <Menu size={19} />
          </button>
          <h1>{names[section]}</h1>
          <div className="cyber-stat">
            <i /> {section === 'live' ? liveCount : '—'} <small>ส่งสัญญาณ</small>
          </div>
          <div className="cyber-stat red">
            {accountsLoading ? '…' : accounts.length} <small>บัญชีที่เพิ่ม</small>
          </div>
          <div className="cyber-stat ready">
            <i /> {systemStatus === 'ready' ? 'ระบบ' : 'รอ'}
            <br />
            {systemStatus === 'ready' ? 'พร้อม' : 'เชื่อม'}
          </div>
          <div className="cyber-stat version">
            <small>VER</small> v0.1.0
          </div>
          <div className="cyber-member">
            <span>●</span>
            <div>
              <strong>{username}</strong>
              <small>บัญชีตัวอย่างแสดงแยกด้านล่าง</small>
            </div>
            <Btn tone="danger" onClick={logout}>
              <LogOut size={12} /> ออก
            </Btn>
          </div>
          <div className="cyber-top-actions">
            <Btn
              onClick={() =>
                section === 'accounts' || section === 'dashboard'
                  ? void loadAccounts()
                  : notify('แสดงข้อมูลตัวอย่างล่าสุดแล้ว')
              }
            >
              <RefreshCw size={13} /> รีเฟรช
            </Btn>
            <Btn tone="pink" onClick={() => setModal('เพิ่มบัญชี')}>
              <Plus size={13} /> เพิ่มบัญชี
            </Btn>
          </div>
        </header>
        <main className="cyber-content">
          {section === 'dashboard' || section === 'accounts' ? (
            accountView()
          ) : section === 'live' ? (
            <LiveSessionPanel
              accounts={accounts}
              onLiveCount={setLiveCount}
              onSetup={(accountId) => {
                const account = accounts.find((item) => item.id === accountId);
                if (account) openAccountSettings(account);
              }}
            />
          ) : section === 'videos' ? (
            videoView()
          ) : section === 'comments' ? (
            commentsView()
          ) : section === 'analytics' ? (
            analyticsView()
          ) : (
            genericView()
          )}
        </main>
      </div>
      {toast && (
        <div className="cyber-toast">
          <CircleCheck size={17} />
          {toast}
          <button onClick={() => setToast('')}>×</button>
        </div>
      )}
      {modal && (
        <div className="cyber-modal-backdrop" onClick={closeModal}>
          <div className="cyber-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cyber-modal-head">
              <h2>▣ {modal}</h2>
              <button onClick={closeModal}>
                <X size={17} />
              </button>
            </div>
            {modal === 'เพิ่มบัญชี' ? (
              <form onSubmit={saveAccount}>
                <div className="cyber-modal-body cyber-account-form">
                  <p>
                    เพิ่มด้วย sessionid แบบในตัวอย่าง หรือใช้ Copy as cURL (bash) จาก DevTools
                    ระบบจะบันทึกบัญชีเมื่ออ่านตัวตนจาก TikTok สำเร็จเท่านั้น
                  </p>
                  <label>
                    ชื่อเรียกบัญชี
                    <input
                      value={accountAlias}
                      onChange={(event) => setAccountAlias(event.target.value)}
                      placeholder="เช่น ร้านหลัก"
                      maxLength={80}
                      autoComplete="off"
                      required
                    />
                  </label>
                  <label>
                    วิธีเพิ่มบัญชี
                    <select
                      value={accountImportMode}
                      onChange={(event) =>
                        setAccountImportMode(event.target.value as 'sessionid' | 'curl')
                      }
                    >
                      <option value="sessionid">TikTok sessionid</option>
                      <option value="curl">cURL จาก DevTools</option>
                    </select>
                  </label>
                  {accountImportMode === 'sessionid' ? (
                    <label>
                      TikTok Session Cookie (sessionid)
                      <input
                        type="password"
                        value={accountSessionId}
                        onChange={(event) => setAccountSessionId(event.target.value)}
                        placeholder="วางค่า sessionid เท่านั้น"
                        autoComplete="off"
                        spellCheck={false}
                        required
                      />
                    </label>
                  ) : (
                    <label>
                      cURL จาก DevTools
                      <textarea
                        value={accountCurl}
                        onChange={(event) => setAccountCurl(event.target.value)}
                        placeholder="วางคำสั่ง cURL ที่คัดลอกจาก DevTools"
                        autoComplete="off"
                        spellCheck={false}
                        required
                      />
                    </label>
                  )}
                  <label>
                    ชื่อหัวข้อไลฟ์เริ่มต้น
                    <input
                      value={accountLiveTitle}
                      onChange={(event) => setAccountLiveTitle(event.target.value)}
                      placeholder="เช่น ไลฟ์ขายของวันนี้"
                      maxLength={120}
                    />
                  </label>
                  <p className="cyber-account-secret-hint">
                    ข้อมูลนี้มี session ของ TikTok อย่าแชร์ในแชทหรือภาพหน้าจอ
                  </p>
                  {accountFormError && (
                    <p className="cyber-account-error" role="alert">
                      {accountFormError}
                    </p>
                  )}
                </div>
                <div className="cyber-modal-actions">
                  <Btn onClick={closeModal}>ปิด</Btn>
                  <Btn tone="pink" type="submit" disabled={accountSubmitting}>
                    {accountSubmitting ? 'กำลังบันทึก…' : 'บันทึกบัญชี'}
                  </Btn>
                </div>
              </form>
            ) : modal === 'ตั้งค่าบัญชี' && selectedAccount ? (
              <form onSubmit={saveAccountSettings}>
                <div className="cyber-modal-body cyber-account-form">
                  <p>
                    ตั้งค่าบัญชี{' '}
                    {selectedAccount.verifiedHandle
                      ? `@${selectedAccount.verifiedHandle}`
                      : selectedAccount.alias}{' '}
                    สำหรับการใช้งานในเว็บนี้
                  </p>
                  <label>
                    ชื่อเรียกบัญชี
                    <input
                      value={accountAlias}
                      onChange={(event) => setAccountAlias(event.target.value)}
                      maxLength={80}
                      required
                    />
                  </label>
                  <label>
                    ชื่อไลฟ์เริ่มต้น
                    <input
                      value={accountLiveTitle}
                      onChange={(event) => setAccountLiveTitle(event.target.value)}
                      placeholder="ตั้งชื่อไลฟ์สำหรับบัญชีนี้"
                      maxLength={120}
                    />
                  </label>
                  <p>ชื่อนี้แสดงในเว็บเท่านั้น ต้องตั้งชื่อห้อง LIVE ใน TikTok เอง</p>
                  <div className="cyber-stream-settings">
                    <strong>ปลายทางสำหรับส่งวิดีโอ</strong>
                    <p>
                      บันทึกครั้งแรกแล้วเริ่มส่งจากการ์ดบัญชีได้ หากห้อง LIVE ออก URL หรือ key ใหม่
                      ให้บันทึกค่าใหม่ที่นี่
                    </p>
                    {streamLoading ? (
                      <p>กำลังโหลดค่าการสตรีม…</p>
                    ) : (
                      <>
                        <p>
                          {streamSession?.hasRtmpConfig
                            ? 'บันทึกปลายทางไว้แล้ว (ไม่แสดง key)'
                            : 'ยังไม่บันทึกปลายทาง'}
                        </p>
                        <label>
                          วิดีโอ MP4
                          <select
                            value={streamVideoId}
                            onChange={(event) => setStreamVideoId(event.target.value)}
                            disabled={streamBusy !== '' || streamSession?.status === 'live'}
                          >
                            <option value="">เลือกวิดีโอ</option>
                            {streamVideos.map((video) => (
                              <option key={video.id} value={video.id}>
                                {video.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        {streamVideos.length === 0 && <p>อัปโหลด MP4 ในหน้า Live Session ก่อน</p>}
                        {streamSession?.hasRtmpConfig &&
                          streamVideoId !== streamSession.videoId && (
                            <button
                              type="button"
                              className="cyber-btn cyan"
                              onClick={() => void saveStreamVideo()}
                              disabled={
                                !streamVideoId ||
                                streamBusy !== '' ||
                                streamSession.status === 'live'
                              }
                            >
                              {streamBusy === 'video' ? 'กำลังบันทึก…' : 'ใช้วิดีโอนี้'}
                            </button>
                          )}
                        <label>
                          RTMP URL
                          <input
                            value={streamUrl}
                            onChange={(event) => setStreamUrl(event.target.value)}
                            placeholder="rtmp:// หรือ rtmps://"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                        <label>
                          Stream key
                          <input
                            type="password"
                            value={streamKey}
                            onChange={(event) => setStreamKey(event.target.value)}
                            placeholder={
                              streamSession?.hasRtmpConfig
                                ? 'กรอกเมื่อต้องการเปลี่ยนปลายทาง'
                                : 'วาง key ที่นี่'
                            }
                            autoComplete="new-password"
                            spellCheck={false}
                          />
                        </label>
                        <p>ระบบเก็บปลายทางแบบเข้ารหัส และไม่ส่ง key กลับมาแสดงอีก</p>
                        <button
                          type="button"
                          className="cyber-btn pink"
                          onClick={() => void saveStreamConfig()}
                          disabled={
                            !streamVideoId ||
                            !streamUrl.trim() ||
                            !streamKey.trim() ||
                            streamBusy !== '' ||
                            streamSession?.status === 'live'
                          }
                        >
                          {streamBusy === 'config'
                            ? 'กำลังบันทึก…'
                            : streamSession?.hasRtmpConfig
                              ? 'เปลี่ยนปลายทาง'
                              : 'บันทึกปลายทางครั้งแรก'}
                        </button>
                      </>
                    )}
                    {streamSetupError && (
                      <p className="cyber-account-error" role="alert">
                        {streamSetupError}
                      </p>
                    )}
                    {streamSetupNotice && (
                      <p className="cyber-live-notice" role="status">
                        {streamSetupNotice}
                      </p>
                    )}
                  </div>
                  {accountFormError && (
                    <p className="cyber-account-error" role="alert">
                      {accountFormError}
                    </p>
                  )}
                </div>
                <div className="cyber-modal-actions">
                  <Btn onClick={closeModal} disabled={settingsSubmitting}>
                    ยกเลิก
                  </Btn>
                  <Btn tone="pink" type="submit" disabled={settingsSubmitting}>
                    {settingsSubmitting ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า'}
                  </Btn>
                </div>
              </form>
            ) : modal === 'ลบบัญชี' && selectedAccount ? (
              <div>
                <div className="cyber-modal-body">
                  <p>
                    ยืนยันลบบัญชี <strong>{selectedAccount.alias}</strong> ออกจากระบบ?
                    ข้อมูลการเชื่อมต่อและการตั้งค่าของบัญชีนี้จะถูกลบ
                  </p>
                  {accountFormError && (
                    <p className="cyber-account-error" role="alert">
                      {accountFormError}
                    </p>
                  )}
                </div>
                <div className="cyber-modal-actions">
                  <Btn onClick={closeModal} disabled={accountDeleting}>
                    ยกเลิก
                  </Btn>
                  <Btn
                    tone="danger"
                    onClick={() => void deleteAccount()}
                    disabled={accountDeleting}
                  >
                    {accountDeleting ? 'กำลังลบ…' : 'ยืนยันลบบัญชี'}
                  </Btn>
                </div>
              </div>
            ) : (
              <>
                <div className="cyber-modal-body">
                  {modal === 'ภาพรวมทุกบัญชี' ? (
                    <>
                      <p>บัญชีที่เพิ่ม {accounts.length} · ไลฟ์จริง 0 · ข้อมูลตัวอย่าง 2</p>
                      {accounts.map((account) => (
                        <div className="cyber-row" key={account.id}>
                          <span>{account.alias}</span>
                          <Badge
                            tone={account.verificationStatus === 'connected' ? 'green' : 'yellow'}
                          >
                            {account.verificationStatus === 'connected'
                              ? 'เชื่อมต่อแล้ว'
                              : 'ยังไม่เชื่อมต่อ'}
                          </Badge>
                        </div>
                      ))}
                      <div className="cyber-row">
                        <span>Demo Shop A</span>
                        <Badge tone="dim">MOCK</Badge>
                      </div>
                      <div className="cyber-row">
                        <span>Demo Shop B</span>
                        <Badge tone="dim">MOCK</Badge>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>ส่วนนี้เป็นหน้าตัวอย่างสำหรับการเชื่อมงานของทีม</p>
                      <label>
                        ชื่อรายการ
                        <input placeholder="กรอกข้อมูลตัวอย่าง" />
                      </label>
                    </>
                  )}
                </div>
                <div className="cyber-modal-actions">
                  <Btn onClick={closeModal}>ปิด</Btn>
                  <Btn
                    tone="pink"
                    onClick={() => {
                      closeModal();
                      notify('บันทึกตัวอย่างแล้ว');
                    }}
                  >
                    บันทึก
                  </Btn>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
