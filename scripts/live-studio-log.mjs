import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const pushPattern = /rtmps?:\/\/[^\s"',}\\]+\/stream-[^\s"',}\\]+/g;

export function extractPushDestinations(text) {
  const results = [];
  for (const line of text.split(/\r?\n/)) {
    const timestamp = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)\]/.exec(line)?.[1];
    if (!timestamp) continue;
    for (const match of line.matchAll(pushPattern)) {
      const fullUrl = match[0].replace(/[;']+$/, '');
      let parsed;
      try {
        parsed = new URL(fullUrl);
      } catch {
        continue;
      }
      if (
        !['rtmp:', 'rtmps:'].includes(parsed.protocol) ||
        !parsed.hostname.toLowerCase().endsWith('.tiktokcdn.com') ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        !/^\/(?:[^/]+\/)*stream-[^/]+$/.test(parsed.pathname)
      )
        continue;
      const slash = parsed.pathname.lastIndexOf('/');
      const rtmpUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname.slice(0, slash)}`;
      const streamKey = `${parsed.pathname.slice(slash + 1)}${parsed.search}`;
      if (streamKey.length > 2048 || rtmpUrl.length > 2048) continue;
      results.push({ timestamp, rtmpUrl, streamKey });
    }
  }
  return results;
}

export async function latestPushDestination(logDir, maxAgeMs = 15 * 60_000) {
  const names = (await readdir(logDir)).filter((name) => /^LS-renderer\..+\.log$/.test(name));
  const candidates = [];
  for (const name of names) {
    const file = join(logDir, name);
    const info = await stat(file);
    if (!info.isFile() || info.size > 30_000_000) continue;
    const text = await readFile(file, 'utf8');
    candidates.push(...extractPushDestinations(text));
  }
  const latest = candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  if (!latest) return null;
  const age = Date.now() - new Date(latest.timestamp).getTime();
  if (!Number.isFinite(age) || age < -60_000 || age > maxAgeMs) return null;
  return latest;
}
