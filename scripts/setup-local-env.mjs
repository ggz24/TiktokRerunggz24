import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.cwd(), '.env');
const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
const entries = new Map();
for (const line of original.split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) entries.set(match[1], match[2]);
}

const defaults = {
  APP_USERNAME: () => 'demo',
  APP_PASSWORD: () => randomBytes(24).toString('base64url'),
  SESSION_SECRET: () => randomBytes(32).toString('base64url'),
  ACCOUNT_ENCRYPTION_KEY: () => randomBytes(32).toString('hex'),
  INTERNAL_API_TOKEN: () => randomBytes(32).toString('base64url'),
  DATABASE_URL: () => 'postgresql://livehub:livehub_dev@localhost:5433/livehub',
  REDIS_URL: () => 'redis://localhost:6380',
  API_PORT: () => '4000',
  API_HOST: () => '127.0.0.1',
  API_INTERNAL_URL: () => 'http://localhost:4000',
};

let updated = original;
for (const [name, generate] of Object.entries(defaults)) {
  const value = entries.get(name);
  const weakDevValue =
    (name === 'APP_PASSWORD' && value === 'demo1234') ||
    (name === 'SESSION_SECRET' && value === 'local-development-only-change-me-before-deploying');
  if (value && !weakDevValue) continue;
  const newLine = `${name}=${generate()}`;
  const existingLine = new RegExp(`^${name}=.*$`, 'm');
  if (entries.has(name)) {
    updated = updated.replace(existingLine, newLine);
  } else {
    updated += `${updated && !updated.endsWith('\n') ? '\n' : ''}${newLine}\n`;
  }
}

if (updated !== original) {
  writeFileSync(path, updated, { mode: 0o600 });
  console.log('Local credentials are ready in .env. Keep this file private.');
} else {
  console.log('Local credentials already exist in .env.');
}
