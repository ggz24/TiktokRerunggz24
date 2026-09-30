import { existsSync, readFileSync } from 'node:fs';

if (!existsSync('.env.production')) {
  console.error('Missing .env.production. Run node scripts/setup-production-env.mjs first.');
  process.exit(1);
}
const values = new Map();
for (const line of readFileSync('.env.production', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) values.set(match[1], match[2]);
}
const errors = [];
const domain = values.get('DOMAIN') ?? '';
if (
  domain === 'example.invalid' ||
  !/^(?=.{4,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain) ||
  domain.endsWith('.invalid')
)
  errors.push('Set DOMAIN to the real hostname (without https://).');
const username = values.get('APP_USERNAME') ?? '';
if (!username || username === 'demo') errors.push('Set a non-demo APP_USERNAME.');
if ((values.get('APP_PASSWORD') ?? '').length < 10)
  errors.push('APP_PASSWORD must have at least 10 characters.');
if ((values.get('SESSION_SECRET') ?? '').length < 32)
  errors.push('SESSION_SECRET must have at least 32 characters.');
if (!/^[a-f0-9]{64}$/i.test(values.get('ACCOUNT_ENCRYPTION_KEY') ?? ''))
  errors.push('ACCOUNT_ENCRYPTION_KEY must be 64 hexadecimal characters.');
if ((values.get('INTERNAL_API_TOKEN') ?? '').length < 32)
  errors.push('INTERNAL_API_TOKEN must have at least 32 characters.');
if (!/^[A-Za-z0-9]{16,}$/.test(values.get('POSTGRES_PASSWORD') ?? ''))
  errors.push('POSTGRES_PASSWORD must be at least 16 alphanumeric characters.');
const limit = values.get('MAX_CONCURRENT_LIVE') ?? '';
if (limit && (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))))
  errors.push('MAX_CONCURRENT_LIVE must be blank or a positive integer.');
if (errors.length) {
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(
    'Production environment format is valid. DNS, server ports, and live integration still require checks.',
  );
}
