import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CredentialStore } from './credential-store.mjs';
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'boxphone-key-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32);
  return { dir, key, store: new CredentialStore(dir, key) };
}
test('keys persist encrypted across restart; API metadata never contains key values', async (t) => {
  const { dir, key, store } = await fixture(t);
  const result = await store.save('alice', {
    transcriptionKey: 'synthetic-transcription-key',
    openaiKey: 'synthetic-openai-key',
    openrouterKey: 'synthetic-router-key',
    questionProvider: 'openrouter',
    questionModels: { openrouter: 'vendor/model' },
  });
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      'hasOpenaiKey',
      'hasOpenrouterKey',
      'hasTranscriptionKey',
      'questionModels',
      'questionProvider',
    ].sort(),
  );
  const disk = await readFile(store.filename('alice'), 'utf8');
  assert.ok(!disk.includes('synthetic-'));
  const restarted = new CredentialStore(dir, key);
  assert.equal(await restarted.resolve('alice', 'openrouterKey', ''), 'synthetic-router-key');
  assert.equal(await restarted.resolve('alice', 'openaiKey', 'temporary-key'), 'temporary-key');
  await restarted.save('alice', { openaiKey: '', questionModels: { openai: 'gpt-4.1-mini' } });
  assert.equal(await restarted.resolve('alice', 'openaiKey', ''), 'synthetic-openai-key');
  assert.equal((await restarted.metadata('alice')).questionProvider, 'openrouter');
});
test('owner isolation, authenticated encryption, and deletion', async (t) => {
  const { dir, key, store } = await fixture(t);
  await store.save('alice', { openaiKey: 'alice-key' });
  await store.save('bob', { openaiKey: 'bob-key' });
  assert.equal(await store.resolve('bob', 'openaiKey', ''), 'bob-key');
  await copyFile(store.filename('alice'), store.filename('mallory'));
  await assert.rejects(store.load('mallory'), /ถอดรหัส/);
  await assert.rejects(new CredentialStore(dir, randomBytes(32)).load('alice'), /ถอดรหัส/);
  await store.clear('alice');
  assert.equal((await store.metadata('alice')).hasOpenaiKey, false);
  assert.equal(await store.resolve('bob', 'openaiKey', ''), 'bob-key');
  await assert.rejects(store.save('bad\0owner', { openaiKey: 'key' }));
});
test('concurrent partial saves retain each provider; invalid keys do not overwrite', async (t) => {
  const { store } = await fixture(t);
  await Promise.all([
    store.save('alice', { transcriptionKey: 'transcription' }),
    store.save('alice', { openaiKey: 'openai' }),
    store.save('alice', { openrouterKey: 'router' }),
  ]);
  assert.equal(await store.resolve('alice', 'transcriptionKey', ''), 'transcription');
  assert.equal(await store.resolve('alice', 'openaiKey', ''), 'openai');
  assert.equal(await store.resolve('alice', 'openrouterKey', ''), 'router');
  await assert.rejects(store.save('alice', { openaiKey: 'bad\nkey' }));
  assert.equal(await store.resolve('alice', 'openaiKey', ''), 'openai');
});
