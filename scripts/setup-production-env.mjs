import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.cwd(), '.env.production');
if (existsSync(target)) {
  console.error('.env.production already exists; existing credentials were not changed.');
  process.exitCode = 1;
} else {
  const local = new Map();
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) local.set(match[1], match[2]);
    }
  }
  const value = (name, fallback) => local.get(name) || fallback();
  const entries = {
    DOMAIN: 'example.invalid',
    APP_USERNAME: value('APP_USERNAME', () => 'admin'),
    APP_PASSWORD: value('APP_PASSWORD', () => randomBytes(24).toString('base64url')),
    SESSION_SECRET: value('SESSION_SECRET', () => randomBytes(32).toString('base64url')),
    ACCOUNT_ENCRYPTION_KEY: value('ACCOUNT_ENCRYPTION_KEY', () => randomBytes(32).toString('hex')),
    INTERNAL_API_TOKEN: value('INTERNAL_API_TOKEN', () => randomBytes(32).toString('base64url')),
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    MAX_CONCURRENT_LIVE: value('MAX_CONCURRENT_LIVE', () => ''),
    RAPIDAPI_KEY: value('RAPIDAPI_KEY', () => ''),
    TIKTOK_STUDIO_VERSION: value('TIKTOK_STUDIO_VERSION', () => '1.36.6'),
    TIKTOK_STUDIO_DEVICE_ID: value('TIKTOK_STUDIO_DEVICE_ID', () => '0'),
    TIKTOK_STUDIO_INSTALL_ID: value('TIKTOK_STUDIO_INSTALL_ID', () => '0'),
    TIKTOK_LIVE_CATEGORY_ID: value('TIKTOK_LIVE_CATEGORY_ID', () => '0'),
  };
  writeFileSync(
    target,
    Object.entries(entries)
      .map(([name, item]) => `${name}=${item}`)
      .join('\n') + '\n',
    {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    },
  );
  console.log('.env.production created. Set DOMAIN and keep this file private.');
}
