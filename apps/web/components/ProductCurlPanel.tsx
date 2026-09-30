'use client';

import { useEffect, useState } from 'react';
import { apiPath } from '@/lib/base-path';

type Account = {
  id: string;
  alias: string;
  verifiedHandle?: string | null;
  verificationStatus: string;
};
type Preview = { roomId: string; productIds: string[]; hasCookie: boolean };
type ProductSet = Preview & {
  id: string;
  name: string;
  accountId: string | null;
  createdAt: string;
  updatedAt: string;
};

async function responseError(response: Response): Promise<string> {
  const result: unknown = await response.json().catch(() => null);
  return result &&
    typeof result === 'object' &&
    'error' in result &&
    typeof result.error === 'string'
    ? result.error
    : 'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง';
}

export default function ProductCurlPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sets, setSets] = useState<ProductSet[]>([]);
  const [editingId, setEditingId] = useState('');
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [curl, setCurl] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadSets() {
    const response = await fetch(apiPath('/api/live/product-sets'), { cache: 'no-store' });
    if (!response.ok) throw new Error(await responseError(response));
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== 'object' ||
      !('items' in result) ||
      !Array.isArray(result.items)
    )
      throw new Error('อ่านชุดสินค้าไม่สำเร็จ');
    setSets(result.items as ProductSet[]);
  }

  useEffect(() => {
    let active = true;
    fetch(apiPath('/api/accounts'), { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((result) => {
        if (active && Array.isArray(result.items)) {
          setAccounts(
            result.items.filter((item: Account) => item.verificationStatus === 'connected'),
          );
        }
      })
      .catch(() => {
        if (active) setAccounts([]);
      });
    fetch(apiPath('/api/live/product-sets'), { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return response.json();
      })
      .then((result) => {
        if (active && Array.isArray(result.items)) setSets(result.items);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'อ่านชุดสินค้าไม่สำเร็จ');
      });
    return () => {
      active = false;
    };
  }, []);

  function resetEditor() {
    setEditingId('');
    setName('');
    setAccountId('');
    setCurl('');
    setPreview(null);
  }

  function editSet(item: ProductSet) {
    setEditingId(item.id);
    setName(item.name);
    setAccountId(item.accountId ?? '');
    setCurl('');
    setPreview({ roomId: item.roomId, productIds: item.productIds, hasCookie: item.hasCookie });
    setError('');
    setNotice('แก้ชื่อได้ทันที หาก cURL หมดอายุ ให้วาง cURL ใหม่แล้วตรวจรายการก่อนบันทึก');
    document
      .getElementById('product-set-editor')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function previewCurl() {
    if (busy || !curl.trim()) return;
    setBusy('preview');
    setError('');
    setNotice('');
    try {
      const response = await fetch(apiPath('/api/live/products'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', curl }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = (await response.json()) as Preview;
      if (typeof result.roomId !== 'string' || !Array.isArray(result.productIds)) {
        throw new Error('อ่านรายการสินค้าไม่สำเร็จ');
      }
      setPreview(result);
      setNotice('ตรวจพบรายการสินค้าแล้ว ตรวจรายการก่อนบันทึกหรือส่งจริง');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ตรวจรายการไม่สำเร็จ');
    } finally {
      setBusy('');
    }
  }

  async function saveSet() {
    if (busy) return;
    if (!name.trim()) {
      setError('ใส่ชื่อชุดสินค้า');
      return;
    }
    if (!editingId && !curl.trim()) {
      setError('วาง cURL สำหรับชุดสินค้า');
      return;
    }
    if (curl.trim() && !preview) {
      setError('ตรวจรายการสินค้าจาก cURL ก่อนบันทึก');
      return;
    }
    if (preview && !preview.hasCookie && !accountId) {
      setError('เลือกบัญชีที่เชื่อมต่อไว้สำหรับ cURL ที่ไม่มี Cookie');
      return;
    }
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const response = await fetch(
        editingId
          ? apiPath(`/api/live/product-sets/${editingId}`)
          : apiPath('/api/live/product-sets'),
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            accountId: accountId || null,
            ...(curl.trim() ? { curl } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      await loadSets();
      resetEditor();
      setNotice(editingId ? 'แก้ไขชุดสินค้าแล้ว' : 'บันทึกชุดสินค้าแล้ว');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'บันทึกชุดสินค้าไม่สำเร็จ');
    } finally {
      setBusy('');
    }
  }

  async function sendCurl() {
    if (busy || !curl.trim() || !preview) return;
    if (!preview.hasCookie && !accountId) {
      setError('เลือกบัญชีที่เชื่อมต่อไว้');
      return;
    }
    if (
      !window.confirm(
        `ส่งสินค้า ${preview.productIds.length} รายการเข้า TikTok Shop Streamer Desktop จริงหรือไม่?`,
      )
    )
      return;
    setBusy('send');
    setError('');
    setNotice('');
    try {
      const response = await fetch(apiPath('/api/live/products'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', curl, ...(accountId ? { accountId } : {}) }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = (await response.json()) as { outcome: string };
      setNotice(
        result.outcome === 'accepted'
          ? 'TikTok Shop ตอบรับคำขอแล้ว ตรวจรายการใน Streamer Desktop อีกครั้ง'
          : 'ส่งคำขอแล้ว แต่ยืนยันผลไม่ได้ ตรวจรายการใน Streamer Desktop',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ส่งสินค้าไม่สำเร็จ');
    } finally {
      setBusy('');
    }
  }

  async function sendSaved(item: ProductSet) {
    if (
      busy ||
      !window.confirm(
        `ส่งชุด “${item.name}” (${item.productIds.length} รายการ) เข้า TikTok Shop Streamer Desktop จริงหรือไม่?`,
      )
    )
      return;
    setBusy(item.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch(apiPath(`/api/live/product-sets/${item.id}/send`), {
        method: 'POST',
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = (await response.json()) as { outcome: string; queuedForLive?: boolean };
      setNotice(
        result.outcome === 'queued'
          ? `บันทึกชุด “${item.name}” เพื่อส่งเข้าห้องใหม่เมื่อกดเริ่มไลฟ์`
          : result.outcome === 'accepted'
            ? `TikTok Shop ตอบรับชุด “${item.name}” แล้ว${result.queuedForLive ? ' และจะส่งซ้ำเมื่อเริ่มไลฟ์' : ''} ตรวจรายการใน Streamer Desktop`
            : `ส่งชุด “${item.name}” แล้ว แต่ยืนยันผลไม่ได้ ตรวจรายการใน Streamer Desktop`,
      );
      await loadSets();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ส่งชุดสินค้าไม่สำเร็จ');
    } finally {
      setBusy('');
    }
  }

  async function deleteSet(item: ProductSet) {
    if (busy || !window.confirm(`ลบชุดสินค้า “${item.name}” หรือไม่?`)) return;
    setBusy(item.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch(apiPath(`/api/live/product-sets/${item.id}`), {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(await responseError(response));
      if (editingId === item.id) resetEditor();
      await loadSets();
      setNotice(`ลบชุด “${item.name}” แล้ว`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ลบชุดสินค้าไม่สำเร็จ');
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="cyber-panel">
      <div className="cyber-panel-title">
        <span className="cyber-spark">▪</span> จัดการชุดสินค้า
      </div>
      <div className="cyber-form-section">
        <p>
          บันทึกชุดจาก cURL ของ <code>live_product/add</code> แล้วกดส่งเข้า TikTok Shop Streamer
          Desktop เมื่อต้องการ
        </p>
        <div className="cyber-product-set-list">
          {sets.length === 0 && <p>ยังไม่มีชุดสินค้าที่บันทึกไว้</p>}
          {sets.map((item) => (
            <div className="cyber-product-set-row" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>
                  {item.productIds.length} รายการ · {item.roomId || 'ก่อนเริ่ม LIVE'}
                </small>
              </div>
              <div className="cyber-product-set-actions">
                <button
                  type="button"
                  className="cyber-btn green"
                  disabled={busy !== ''}
                  onClick={() => void sendSaved(item)}
                >
                  {busy === item.id ? 'กำลังดำเนินการ…' : '⚡ ส่งเข้า LIVE'}
                </button>
                <button
                  type="button"
                  className="cyber-btn secondary"
                  disabled={busy !== ''}
                  onClick={() => editSet(item)}
                >
                  ✎ แก้ไข
                </button>
                <button
                  type="button"
                  className="cyber-btn danger"
                  disabled={busy !== ''}
                  onClick={() => void deleteSet(item)}
                >
                  ลบ
                </button>
              </div>
            </div>
          ))}
        </div>
        <div id="product-set-editor" className="cyber-product-set-editor">
          <h3>{editingId ? 'แก้ไขชุดสินค้า' : 'เพิ่มชุดสินค้า'}</h3>
          <label className="cyber-field">
            ชื่อชุดสินค้า
            <input
              className="cyber-input"
              value={name}
              maxLength={80}
              disabled={busy !== ''}
              onChange={(event) => setName(event.target.value)}
              placeholder="เช่น สินค้าสำหรับ LIVE วันนี้"
            />
          </label>
          <label className="cyber-field">
            บัญชีที่จะให้ส่งชุดนี้ซ้ำเมื่อเริ่ม LIVE
            <select
              className="cyber-select"
              value={accountId}
              disabled={busy !== ''}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">ไม่ผูกบัญชี · ใช้ Cookie ใน cURL</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.alias} {account.verifiedHandle ? `(@${account.verifiedHandle})` : ''}
                </option>
              ))}
            </select>
          </label>
          <p>
            หาก cURL มี Cookie ระบบจะใช้ Cookie จาก cURL ในการส่งสินค้าเสมอ บัญชีที่เลือกใช้กำหนดว่า
            จะส่งชุดนี้ซ้ำเมื่อเริ่ม LIVE ของบัญชีใด
          </p>
          <label className="cyber-field">
            cURL จาก TikTok Shop Streamer Desktop
            <textarea
              className="cyber-textarea"
              rows={9}
              value={curl}
              disabled={busy !== ''}
              onChange={(event) => {
                setCurl(event.target.value);
                setPreview(null);
                setNotice('');
              }}
              placeholder={
                editingId
                  ? 'ปล่อยว่างเพื่อใช้ cURL เดิม หรือวาง cURL ใหม่เพื่อเปลี่ยนรายการสินค้า'
                  : "curl --url 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/add?...' ..."
              }
            />
          </label>
          <p>
            cURL ที่บันทึกเข้ารหัสไว้และไม่แสดงกลับบนหน้าเว็บ เมื่อ token หมดอายุ ให้กดแก้ไขแล้ววาง
            cURL ใหม่
          </p>
          <div className="cyber-product-set-actions">
            <button
              className="cyber-btn cyan"
              type="button"
              disabled={!curl.trim() || busy !== ''}
              onClick={() => void previewCurl()}
            >
              {busy === 'preview' ? 'กำลังตรวจ…' : 'ตรวจรายการสินค้า'}
            </button>
            <button
              className="cyber-btn pink"
              type="button"
              disabled={
                busy !== '' ||
                !name.trim() ||
                (!editingId && !preview) ||
                (curl.trim() !== '' && !preview)
              }
              onClick={() => void saveSet()}
            >
              {busy === 'save' ? 'กำลังบันทึก…' : editingId ? 'บันทึกการแก้ไข' : 'บันทึกชุดสินค้า'}
            </button>
            {curl.trim() && preview && (
              <button
                className="cyber-btn green"
                type="button"
                disabled={busy !== '' || (!preview.hasCookie && !accountId)}
                onClick={() => void sendCurl()}
              >
                {busy === 'send' ? 'กำลังส่ง…' : 'ส่ง cURL นี้เข้า LIVE'}
              </button>
            )}
            {editingId && (
              <button
                className="cyber-btn secondary"
                type="button"
                disabled={busy !== ''}
                onClick={resetEditor}
              >
                ยกเลิกแก้ไข
              </button>
            )}
          </div>
          {preview && (
            <div className="cyber-product-set-preview">
              <strong>
                พบสินค้า {preview.productIds.length} รายการ · {preview.roomId || 'ก่อนเริ่ม LIVE'}
              </strong>
              <span>{preview.productIds.join(', ')}</span>
              {!preview.hasCookie && !accountId && (
                <span role="alert">เลือกบัญชีที่เชื่อมต่อไว้ก่อนบันทึกหรือส่ง</span>
              )}
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="cyber-product-set-message">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="cyber-product-set-message">
            {notice}
          </p>
        )}
        <p>
          คำขอนี้เพิ่มสินค้าเข้ารายการใน Streamer Desktop การปักแสดงสินค้าเด่นหนึ่งชิ้นบนจอ LIVE
          ใช้คำสั่งอีกชนิด
        </p>
      </div>
    </section>
  );
}
