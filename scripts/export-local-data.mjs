import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const folder = `backup-local-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
const destination = new URL(`../backups/${folder}/`, import.meta.url);

async function exportCommand(file, service, ...args) {
  const child = spawn('docker', ['compose', '-f', 'compose.yaml', 'exec', '-T', service, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const output = createWriteStream(new URL(file, destination), { mode: 0o600 });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${service} export failed (${code})`)),
    );
  });
  await Promise.all([pipeline(child.stdout, output), result]);
}

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(new URL(file, destination))) hash.update(chunk);
  return `${hash.digest('hex')}  ${file}`;
}

await mkdir(destination, { recursive: true, mode: 0o700 });
try {
  await readFile(new URL('../.env.production', import.meta.url));
  await exportCommand(
    'database.dump',
    'postgres',
    'pg_dump',
    '-U',
    'livehub',
    '-d',
    'livehub',
    '-Fc',
  );
  await exportCommand('media.tar', 'api', 'tar', '-C', '/app/media', '-cf', '-', '.');
  await copyFile(
    new URL('../.env.production', import.meta.url),
    new URL('secrets.env', destination),
  );
  const checksums = await Promise.all(['database.dump', 'media.tar', 'secrets.env'].map(checksum));
  await writeFile(new URL('SHA256SUMS', destination), `${checksums.join('\n')}\n`, { mode: 0o600 });
  console.log(`Local Docker data exported to ${join('backups', folder)}`);
  console.log('Transfer this directory securely; it contains account secrets and videos.');
} catch (error) {
  await rm(destination, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
