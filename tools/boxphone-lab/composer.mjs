import { TIKTOK_PACKAGES, nativeLiveHeader } from './target-policy.mjs';
import { currentSendTarget, typedEditor } from './delivery.mjs';

const label = (n) => `${n.text || ''} ${n.desc || ''} ${n.resourceId || ''}`;
const hint =
  /พิมพ์|say something|add a comment|add comment|ส่งข้อความ|เขียนข้อความ|แชท|comment_input|chat_input/i;
const avoid = /gift|ของขวัญ|share|แชร์|follow|ติดตาม|search|ค้นหา|password|รหัสผ่าน|cart|ตะกร้า/i;
export const isEditor = (n) => /EditText/i.test(n?.className || '');
export function validUiNode(n, size) {
  const b = n?.bounds;
  return (
    !!b &&
    n.enabled &&
    n.visible !== false &&
    !n.password &&
    TIKTOK_PACKAGES.includes(n.packageName) &&
    [b.x1, b.y1, b.x2, b.y2, b.cx, b.cy].every(Number.isFinite) &&
    b.x1 >= 0 &&
    b.y1 >= 0 &&
    b.x2 <= size.width &&
    b.y2 <= size.height &&
    b.w >= 4 &&
    b.h >= 4 &&
    !avoid.test(label(n))
  );
}
// Require a recognized LIVE screen and one explicit composer, never a score or screen ratio guess.
export function selectChatNode(nodes, size) {
  if (
    nodes.some((n) =>
      /LIVE has ended|live ended|ไลฟ์สิ้นสุด|ไลฟ์จบแล้ว|การถ่ายทอดสดสิ้นสุด/i.test(label(n)),
    )
  )
    return null;
  if (
    nodes.some(
      (n) => n.resourceId === n.packageName + ':id/qww' && TIKTOK_PACKAGES.includes(n.packageName),
    )
  )
    return null;
  const valid = nodes.filter((n) => validUiNode(n, size));
  const edits = valid.filter(isEditor);
  if (edits.length > 1) return null;
  const header = nativeLiveHeader(nodes, size.height);
  const modal = edits.filter(
    (n) =>
      n.resourceId === n.packageName + ':id/g7d' &&
      nodes.some(
        (x) =>
          x.packageName === n.packageName &&
          x.enabled &&
          x.resourceId === n.packageName + ':id/view_shadow',
      ) &&
      nodes.some(
        (x) =>
          x.packageName === n.packageName &&
          x.enabled &&
          x.resourceId === n.packageName + ':id/tnl' &&
          validUiNode(x, size) &&
          x.bounds.cx > n.bounds.cx &&
          Math.abs(x.bounds.cy - n.bounds.cy) < Math.max(48, n.bounds.h),
      ),
  );
  if (modal.length === 1) return modal[0];
  if (!header) return null;
  const inputs = edits.filter((n) => n.packageName === header.packageName && hint.test(label(n)));
  if (inputs.length === 1) return inputs[0];
  const collapsed = valid.filter(
    (n) =>
      n.packageName === header.packageName &&
      !isEditor(n) &&
      (n.resourceId === n.packageName + ':id/g3t' ||
        ((n.clickable || /TextView/i.test(n.className)) &&
          hint.test(`${n.text || ''} ${n.desc || ''}`))) &&
      n.bounds.cy > size.height * 0.5,
  );
  return collapsed.length === 1 ? collapsed[0] : null;
}
export function focusedComposer(nodes, size) {
  const node = selectChatNode(nodes, size);
  return node && isEditor(node) && node.focused ? node : null;
}
export function verifiedTypedComposer(nodes, size, text) {
  const editor = focusedComposer(nodes, size);
  return editor && typedEditor(nodes, text) === editor ? editor : null;
}
export function verifiedSendTarget(nodes, size, text) {
  const editor = verifiedTypedComposer(nodes, size, text);
  const send = currentSendTarget(nodes, editor);
  return send &&
    validUiNode(send, size) &&
    send.bounds.w < size.width * 0.3 &&
    send.bounds.h < Math.max(96, editor.bounds.h * 3) &&
    Math.abs(send.bounds.cy - editor.bounds.cy) <= Math.max(24, editor.bounds.h * 0.5)
    ? { editor, send }
    : null;
}
const fingerprint = (n) =>
  n
    ? [
        n.packageName,
        n.resourceId,
        n.className,
        n.focused,
        n.text,
        n.bounds.x1,
        n.bounds.y1,
        n.bounds.x2,
        n.bounds.y2,
      ].join('\0')
    : '';
export const sameNode = (a, b) => !!a && !!b && fingerprint(a) === fingerprint(b);
// Re-read only; retrying a screen read never repeats a tap, typing or send.
export async function stableTarget(read, select, { pause = async () => {}, attempts = 3 } = {}) {
  let previous = null;
  for (let i = 0; i < attempts; i++) {
    const nodes = await read();
    const target = select(nodes);
    const same = target?.editor
      ? sameNode(previous?.target?.editor, target.editor) &&
        sameNode(previous?.target?.send, target.send)
      : sameNode(previous?.target, target);
    if (target && same) return { nodes, target };
    previous = target ? { nodes, target } : null;
    if (i < attempts - 1) await pause(150);
  }
  throw Error(
    'ตำแหน่งช่องพิมพ์หรือปุ่มส่งยังไม่ชัดเจน/กำลังเปลี่ยน จึงหยุด กรุณาเปิดห้อง LIVE ให้เห็นช่องพิมพ์แล้วตรวจใหม่',
  );
}
export async function prepareComposer({ read, size, tap, pause }) {
  const entry = await stableTarget(read, (nodes) => selectChatNode(nodes, size), { pause });
  if (!isEditor(entry.target) || !entry.target.focused) {
    await tap(entry.target.bounds.cx, entry.target.bounds.cy);
    await pause(300);
  }
  const focused = await stableTarget(read, (nodes) => focusedComposer(nodes, size), { pause });
  if (focused.target.packageName !== entry.target.packageName)
    throw Error('แอปเปลี่ยนระหว่างเปิดช่องพิมพ์ จึงหยุด');
  return focused;
}
