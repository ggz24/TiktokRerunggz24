import test from 'node:test';
import assert from 'node:assert/strict';
import { uiDumpSucceeded } from './server.mjs';

test('a failed or unrelated dump cannot authorize reading old screen XML', () => {
  for (const output of [
    '',
    'ERROR: could not get idle state.',
    'UI hierchary dumped to: /sdcard/other.xml',
    'ERROR\nUI hierchary dumped to: /sdcard/boxphone_ui.xml',
  ])
    assert.equal(uiDumpSucceeded(output), false);
  assert.equal(uiDumpSucceeded('UI hierchary dumped to: /sdcard/boxphone_ui.xml\r\n'), true);
  assert.equal(uiDumpSucceeded('UI hierarchy dumped to: /sdcard/boxphone_ui.xml\n'), true);
});
