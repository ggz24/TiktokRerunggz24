import { similar } from './message-policy.mjs';

/** Whole-clip question plans: listen to a library video once, then ask by playback position. */
export const CHUNK_SECONDS = 60;
export const MAX_QUESTION_LENGTH = 120;
export const MAX_LATE_SECONDS = 300;
// The channel audio window already assumes the played position lags the clock by this much.
export const PLAYBACK_ALLOWANCE_SECONDS = 8;

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function parseClock(text) {
  const parts = String(text).trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d{1,5}$/.test(p.trim())))
    return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

export function defaultQuestionCount(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 4;
  return Math.max(4, Math.min(30, Math.ceil(duration / 240)));
}

/** Start offsets of the 60s audio windows that cover the whole clip. Windows shorter than 5s are skipped. */
export function chunkStarts(duration, size = CHUNK_SECONDS) {
  if (!Number.isFinite(duration) || duration < 5) return [];
  const starts = [];
  for (let start = 0; duration - start >= 5; start += size) starts.push(start);
  return starts;
}

export function transcriptForPlan(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .filter((c) => c && Number.isFinite(c.start) && typeof c.text === 'string' && c.text.trim())
    .sort((a, b) => a.start - b.start)
    .map((c) => `[${formatClock(c.start)}] ${c.text.trim().replace(/\s+/g, ' ')}`)
    .join('\n');
}

/** Clean AI/user supplied plan rows: bounded time, short unique text, spaced by minGap, sorted. */
export function normalizePlan(rows, { duration, count = 30, minGap = 120, previous = [] } = {}) {
  const limit = Math.max(1, Math.min(60, Number(count) || 1));
  const gap = Math.max(0, Number(minGap) || 0);
  const last = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 5) : Infinity;
  const candidates = (Array.isArray(rows) ? rows : [])
    .flatMap((row) => {
      const at = Number(row?.at ?? row?.at_seconds);
      const text =
        typeof row?.text === 'string'
          ? row.text
          : typeof row?.question === 'string'
            ? row.question
            : '';
      const clean = text.trim().replace(/\s+/g, ' ');
      if (
        !Number.isFinite(at) ||
        at < 0 ||
        !clean ||
        Array.from(clean).length > MAX_QUESTION_LENGTH
      )
        return [];
      return [{ at: Math.min(Math.floor(at), last), text: clean }];
    })
    .sort((a, b) => a.at - b.at);
  const out = [];
  for (const item of candidates) {
    if (out.length >= limit) break;
    if (out.length && item.at - out[out.length - 1].at < gap) continue;
    if ([...previous, ...out.map((x) => x.text)].some((x) => similar(item.text, x))) continue;
    out.push(item);
  }
  return out;
}

/** "m:ss | question" per line, the editable form of a plan. */
export function planToText(items) {
  return items.map((i) => `${formatClock(i.at)} | ${i.text}`).join('\n');
}

export function planFromText(text, options) {
  const rows = String(text)
    .split(/\r?\n/)
    .flatMap((line) => {
      const bar = line.indexOf('|');
      if (bar < 1) return [];
      const at = parseClock(line.slice(0, bar));
      return at === null ? [] : [{ at, text: line.slice(bar + 1) }];
    });
  return normalizePlan(rows, options);
}

/** Where the looping rerun is now. The channel started at startedAt and plays the clip from 0 in a loop. */
export function playbackPosition(startedAt, now, duration, allowance = PLAYBACK_ALLOWANCE_SECONDS) {
  const started = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  const played = (now - started) / 1000 - allowance;
  if (!Number.isFinite(played) || played < 0 || !Number.isFinite(duration) || duration <= 0)
    return null;
  return { loop: Math.floor(played / duration), position: played % duration };
}

/**
 * Questions whose time has come and that have not been used in this loop of this stream.
 * Anything older than maxLate seconds is stale (the page was closed or phones were busy) and is skipped.
 */
export function planDue(items, { startedAt, now, duration }, used, maxLate = MAX_LATE_SECONDS) {
  const where = playbackPosition(startedAt, now, duration);
  if (!where) return { position: null, due: [], stale: [] };
  const due = [],
    stale = [];
  items.forEach((item, index) => {
    const id = `${where.loop}:${index}`;
    if (used.has(id) || item.at > where.position) return;
    (where.position - item.at > maxLate ? stale : due).push({ id, ...item });
  });
  return { position: where.position, due, stale };
}
