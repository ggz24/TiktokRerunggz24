// Run on the Windows host after opening a test room in TikTok LIVE Studio.
// Reads a recent push destination from local Studio logs and sends it only to
// this project's local API. No RTMP URL, key, or account session is printed.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { latestPushDestination } from './live-studio-log.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const mode = args.includes('--start') ? 'start' : args.includes('--list') ? 'list' : '';
if (!mode || (mode === 'start' && (!option('--account-id') || !option('--video-id')))) {
  console.error('Use --list, or --start --account-id UUID --video-id UUID');
  process.exit(2);
}

const envText = await readFile(resolve('.env'), 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]),
);
if (!env.INTERNAL_API_TOKEN || !env.APP_USERNAME) {
  throw new Error('Local API credentials are missing from .env');
}
const api = 'http://127.0.0.1:4000';
const headers = {
  'x-internal-token': env.INTERNAL_API_TOKEN,
  'x-livehub-owner': env.APP_USERNAME,
};
async function call(path, method = 'GET', body) {
  const response = await fetch(new URL(path, api), {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Local API returned HTTP ${response.status}`);
  return response.json();
}

try {
  if (mode === 'list') {
    const [accounts, videos] = await Promise.all([
      call('/api/v1/accounts'),
      call('/api/v1/live/videos'),
    ]);
    console.log(
      'Accounts:',
      accounts.items.map(({ id, alias, verificationStatus }) => ({
        id,
        alias,
        verificationStatus,
      })),
    );
    console.log(
      'Videos:',
      videos.items.map(({ id, name, sizeBytes }) => ({ id, name, sizeBytes })),
    );
  } else {
    const accountId = option('--account-id');
    const videoId = option('--video-id');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(accountId) || !uuid.test(videoId))
      throw new Error('Invalid account or video ID');
    const logDir =
      process.env.LIVE_STUDIO_LOG_DIR ??
      resolve(process.env.APPDATA ?? '', 'TikTok LIVE Studio', 'logs');
    const destination = await latestPushDestination(logDir);
    if (!destination) throw new Error('No recent TikTok LIVE Studio push destination was found');
    const accounts = await call('/api/v1/accounts');
    const account = accounts.items.find((item) => item.id === accountId);
    if (!account || account.verificationStatus !== 'connected')
      throw new Error('Select a connected account');
    const videos = await call('/api/v1/live/videos');
    if (!videos.items.some((item) => item.id === videoId))
      throw new Error('Select an uploaded video');
    const status = await call(`/api/v1/live/sessions/${accountId}/status`);
    if (status.item.status !== 'idle' && status.item.status !== 'failed') {
      throw new Error('This account is already sending a stream');
    }
    await call(`/api/v1/live/sessions/${accountId}/config`, 'PUT', {
      rtmpUrl: destination.rtmpUrl,
      streamKey: destination.streamKey,
      videoId,
    });
    const started = await call(`/api/v1/live/sessions/${accountId}/start`, 'POST');
    console.log(
      `Stream process state: ${started.item.status}. Check the viewer's TikTok app to confirm visibility.`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local start failed');
  process.exitCode = 1;
}
