export const GLOBAL_GAP_MS = 30000;
export const DEVICE_GAP_MS = 120000;
export function normalize(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(ครับ|ค่ะ|คะ)[?!？!。\s]*$/u, '')
    .replace(/[\p{P}\p{Z}\s]/gu, '');
}
export function similar(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 8) return false;
  const grams = (s) =>
    new Set(Array.from({ length: Math.max(0, s.length - 2) }, (_, i) => s.slice(i, i + 3)));
  const x = grams(a),
    y = grams(b);
  const overlap = [...x].filter((g) => y.has(g)).length;
  return (2 * overlap) / (x.size + y.size) >= 0.82;
}
export function uniqueQuestions(values, previous = [], limit = 5) {
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text || text.length > 500) continue;
    if ([...previous, ...out].some((x) => similar(text, x))) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}
export function assignQuestions(texts, serials, previous = []) {
  const ids = [...new Set(serials)];
  return uniqueQuestions(texts, previous, ids.length)
    .slice(0, ids.length)
    .map((text, i) => ({ serial: ids[i], text }));
}
export function waitForSend(now, lastGlobal, lastDevice) {
  return Math.max(
    0,
    lastGlobal ? lastGlobal + GLOBAL_GAP_MS - now : 0,
    lastDevice ? lastDevice + DEVICE_GAP_MS - now : 0,
  );
}
