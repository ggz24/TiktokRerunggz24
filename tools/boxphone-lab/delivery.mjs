const clean = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
const isEdit = (n) => /EditText/i.test(n.className);
const forbidden = /gift|ของขวัญ|share|แชร์|follow|ติดตาม|cart|ตะกร้า/i;
export function typedEditor(nodes, text) {
  const editors = nodes.filter(
    (n) => isEdit(n) && n.enabled && n.focused && clean(n.text) === clean(text),
  );
  return editors.length === 1 ? editors[0] : null;
}
export function currentSendTarget(nodes, editor) {
  if (!editor) return null;
  const candidates = nodes.filter(
    (n) =>
      n.enabled &&
      n.clickable &&
      !isEdit(n) &&
      n.packageName === editor.packageName &&
      !forbidden.test(`${n.text} ${n.desc} ${n.resourceId}`) &&
      (/^(send|ส่ง|ส่งข้อความ|ส่งความคิดเห็น|post|โพสต์)$/i.test(clean(n.text)) ||
        /^(send|ส่ง|ส่งข้อความ|ส่งความคิดเห็น|post|โพสต์)$/i.test(clean(n.desc)) ||
        /(?:^|[/_:])(?:send|send_button|btn_send|comment_send|send_comment)(?:$|_button$)/i.test(
          n.resourceId,
        ) ||
        // Verified against this installed TikTok UI dump and screenshot, not a stored coordinate.
        (editor.resourceId === 'com.zhiliaoapp.musically:id/g7d' &&
          n.resourceId === 'com.zhiliaoapp.musically:id/tnl')) &&
      n.bounds.cx > editor.bounds.cx &&
      Math.abs(n.bounds.cy - editor.bounds.cy) < Math.max(48, editor.bounds.h),
  );
  return candidates.length === 1 ? candidates[0] : null;
}
export function deliveryObservation(before, after, editor, text) {
  const sameEditor = after.find(
    (n) =>
      isEdit(n) &&
      n.packageName === editor.packageName &&
      (editor.resourceId ? n.resourceId === editor.resourceId : n.focused),
  );
  const matching = (nodes) =>
    nodes.filter(
      (n) =>
        !isEdit(n) &&
        n.packageName === editor.packageName &&
        (/comment|chat[_:/-]?(?:text|message|content)|message[_:/-]?(?:text|content)/i.test(
          n.resourceId,
        ) ||
          n.resourceId === 'com.zhiliaoapp.musically:id/ecp') &&
        clean(n.text) === clean(text),
    );
  if (sameEditor && clean(sameEditor.text) === clean(text)) return 'still_in_input';
  if (
    (!sameEditor || !clean(sameEditor.text)) &&
    matching(before).length === 0 &&
    matching(after).length > 0
  )
    return 'observed_local';
  return 'unverified';
}
