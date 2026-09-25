import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('LIVEHUB1');
const ivLength = 12;
const tagLength = 16;

const [operation, inputName, outputName, keyName] = process.argv.slice(2);
if (!['encrypt', 'decrypt'].includes(operation) || !inputName || !outputName || !keyName) {
  console.error(
    'Usage: node scripts/transfer-vault.mjs <encrypt|decrypt> <input> <output> <key-file>',
  );
  process.exit(2);
}

const input = resolve(inputName);
const output = resolve(outputName);
const keyFile = resolve(keyName);
if (input === output || existsSync(output)) {
  throw new Error('Choose a new output path; existing files are never overwritten.');
}
const keyText = readFileSync(keyFile, 'utf8').trim();
if (!/^[0-9a-f]{64}$/i.test(keyText)) {
  throw new Error('The key file must contain exactly 64 hexadecimal characters.');
}
const key = Buffer.from(keyText, 'hex');

if (operation === 'encrypt') {
  const iv = randomBytes(ivLength);
  const header = Buffer.concat([magic, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  writeFileSync(output, header, { flag: 'wx' });
  try {
    await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: 'a' }));
    writeFileSync(output, cipher.getAuthTag(), { flag: 'a' });
    console.log('Encrypted transfer archive created. Keep the key file separate from Git.');
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  }
} else {
  const size = statSync(input).size;
  const headerLength = magic.length + ivLength;
  if (size < headerLength + tagLength) throw new Error('Encrypted archive is incomplete.');
  const header = Buffer.alloc(headerLength);
  const tag = Buffer.alloc(tagLength);
  const file = openSync(input, 'r');
  try {
    if (
      readSync(file, header, 0, headerLength, 0) !== headerLength ||
      readSync(file, tag, 0, tagLength, size - tagLength) !== tagLength
    ) {
      throw new Error('Encrypted archive is incomplete.');
    }
  } finally {
    closeSync(file);
  }
  if (!header.subarray(0, magic.length).equals(magic)) {
    throw new Error('Encrypted archive format is not recognized.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(input, { start: headerLength, end: size - tagLength - 1 }),
      decipher,
      createWriteStream(output, { flags: 'wx' }),
    );
    console.log('Transfer archive decrypted and authenticated.');
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  }
}

key.fill(0);
