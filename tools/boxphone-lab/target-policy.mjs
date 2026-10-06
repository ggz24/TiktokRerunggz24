export const TIKTOK_PACKAGES = ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'];
export function liveUrl(handle) {
  if (typeof handle !== 'string' || !/^[A-Za-z0-9._]{1,32}$/.test(handle))
    throw new Error('ชื่อช่องไม่ถูกต้อง');
  return `https://www.tiktok.com/@${handle}/live`;
}
const label = (n) => `${n.text || ''} ${n.desc || ''}`;
const appNode = (n) => TIKTOK_PACKAGES.includes(n.packageName) && n.enabled;
const contains = (outer, inner) =>
  inner.cx >= outer.x1 && inner.cx <= outer.x2 && inner.cy >= outer.y1 && inner.cy <= outer.y2;
// Resource IDs and geometry observed on the connected TikTok build. Other builds fail closed.
export function nativeProfileIdentity(nodes) {
  const cards = nodes.filter((n) => appNode(n) && n.resourceId === n.packageName + ':id/qww');
  if (cards.length !== 1) return null;
  const card = cards[0];
  const inside = nodes.filter(
    (n) => appNode(n) && n.packageName === card.packageName && contains(card.bounds, n.bounds),
  );
  const names = inside.filter((n) => n.resourceId === n.packageName + ':id/o__' && n.text?.trim());
  const handles = inside.filter(
    (n) =>
      n.resourceId === n.packageName + ':id/zud' &&
      /^[A-Za-z0-9._]{1,32}$/.test(n.text?.replace(/^@/, '')),
  );
  if (names.length !== 1 || handles.length !== 1) return null;
  return {
    displayName: names[0].text.trim(),
    handle: handles[0].text.replace(/^@/, ''),
    packageName: card.packageName,
  };
}
export function nativeLiveHeader(nodes, height) {
  if (
    nodes.some((n) =>
      /LIVE has ended|live ended|ไลฟ์สิ้นสุด|ไลฟ์จบแล้ว|การถ่ายทอดสดสิ้นสุด/i.test(label(n)),
    )
  )
    return null;
  const headers = nodes.filter(
    (n) =>
      appNode(n) &&
      n.clickable &&
      n.resourceId === n.packageName + ':id/ap_' &&
      n.bounds.cy < height * 0.2,
  );
  if (headers.length !== 1) return null;
  const header = headers[0];
  const names = nodes.filter(
    (n) =>
      appNode(n) &&
      n.packageName === header.packageName &&
      n.resourceId === n.packageName + ':id/zud' &&
      contains(header.bounds, n.bounds) &&
      n.text?.trim(),
  );
  const close = nodes.some(
    (n) =>
      appNode(n) &&
      n.packageName === header.packageName &&
      n.clickable &&
      n.resourceId === n.packageName + ':id/dm0' &&
      n.bounds.cy < height * 0.2,
  );
  const chat = nodes.some(
    (n) =>
      appNode(n) &&
      n.packageName === header.packageName &&
      n.bounds.cy > height * 0.5 &&
      (n.resourceId === n.packageName + ':id/g3t' || /EditText/i.test(n.className)),
  );
  if (names.length !== 1 || !close || !chat) return null;
  return {
    displayName: names[0].text.trim(),
    packageName: header.packageName,
    bounds: header.bounds,
  };
}
export function nativeLiveComposer(nodes, height) {
  if (
    nodes.some((n) =>
      /LIVE has ended|live ended|ไลฟ์สิ้นสุด|ไลฟ์จบแล้ว|การถ่ายทอดสดสิ้นสุด/i.test(label(n)),
    )
  )
    return null;
  const edits = nodes.filter(
    (n) =>
      appNode(n) &&
      n.focused &&
      /EditText/i.test(n.className) &&
      n.resourceId === n.packageName + ':id/g7d' &&
      n.bounds.cy > height * 0.5,
  );
  if (edits.length !== 1) return null;
  const edit = edits[0];
  const modal = nodes.some(
    (n) =>
      appNode(n) &&
      n.packageName === edit.packageName &&
      n.resourceId === n.packageName + ':id/view_shadow',
  );
  // The empty composer exposes the send icon as non-clickable until text is entered.
  const send = nodes.some(
    (n) =>
      appNode(n) &&
      n.packageName === edit.packageName &&
      n.resourceId === n.packageName + ':id/tnl' &&
      n.bounds.cx > edit.bounds.cx &&
      Math.abs(n.bounds.cy - edit.bounds.cy) < Math.max(48, edit.bounds.h),
  );
  return modal && send ? edit : null;
}
export function verifiedComposerVisible(nodes, identity, height, verifiedAt, now = Date.now()) {
  if (!identity || !Number.isFinite(verifiedAt) || now < verifiedAt || now - verifiedAt > 30000)
    return false;
  const header = nativeLiveHeader(nodes, height);
  if (header && header.displayName !== identity.displayName) return false;
  return nativeLiveComposer(nodes, height)?.packageName === identity.packageName;
}
export function channelVisible(nodes, handle, height) {
  liveUrl(handle);
  const top = height || Math.max(0, ...nodes.map((n) => n.bounds.y2));
  // Match the host identity near the header, never a viewer's name/message in the chat.
  const identities = nodes.filter(
    (n) =>
      TIKTOK_PACKAGES.includes(n.packageName) &&
      n.enabled &&
      n.bounds.cy < top * 0.4 &&
      [n.text, n.desc].some(
        (s) =>
          String(s || '')
            .trim()
            .replace(/^@/, '')
            .toLowerCase() === handle.toLowerCase(),
      ),
  );
  const chat = nodes.some(
    (n) =>
      TIKTOK_PACKAGES.includes(n.packageName) &&
      n.enabled &&
      n.bounds.cy > top * 0.5 &&
      /พิมพ์|comment|say something|add a comment|ส่งข้อความ|แชท/i.test(label(n)),
  );
  const live = nodes.some(
    (n) =>
      TIKTOK_PACKAGES.includes(n.packageName) &&
      n.enabled &&
      (/live[_:/-]?(?:room|chat|comment|audience)/i.test(n.resourceId || '') ||
        (n.bounds.cy < top * 0.5 && /\bLIVE\b|ไลฟ์สด|ถ่ายทอดสด/i.test(label(n)))),
  );
  const closed = nodes.some((n) =>
    /LIVE has ended|live ended|ไลฟ์สิ้นสุด|ไลฟ์จบแล้ว|การถ่ายทอดสดสิ้นสุด/i.test(label(n)),
  );
  return identities.length > 0 && chat && live && !closed;
}
export function validTarget(target) {
  return (
    !!target &&
    typeof target.accountId === 'string' &&
    typeof target.key === 'string' &&
    target.key.length <= 250 &&
    typeof target.handle === 'string' &&
    /^[A-Za-z0-9._]{1,32}$/.test(target.handle)
  );
}
export function bindingMatches(job, accountId, currentTarget) {
  return (
    !!job?.target &&
    accountId === job.target.accountId &&
    (!currentTarget || currentTarget.key === job.target.key)
  );
}
export function groupDevices(serials, assignments, channels) {
  const groups = new Map();
  for (const serial of serials) {
    const channel = channels.find(
      (c) => c.id === assignments[serial] && c.connected && c.status === 'live',
    );
    if (!channel) continue;
    if (!groups.has(channel.id)) groups.set(channel.id, { channel, serials: [] });
    groups.get(channel.id).serials.push(serial);
  }
  return [...groups.values()];
}
