import test from 'node:test';
import assert from 'node:assert/strict';
import { freshUi } from './fresh-ui.mjs';
test('failed dumps never read stale files and use a different file on retry', async () => {
  const calls = [],
    paths = [];
  let attempt = 0;
  const xml = '<hierarchy><node text="current" /></hierarchy>';
  const out = await freshUi(async (args) => {
    calls.push(args);
    if (args[1] === 'uiautomator') {
      paths.push(args[3]);
      return {
        stdout:
          ++attempt === 1
            ? 'ERROR: could not get idle state.'
            : `UI hierchary dumped to: ${args[3]}`,
      };
    }
    return { stdout: args[1] === 'cat' ? xml : '' };
  });
  assert.equal(out, xml);
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
  assert.deepEqual(
    calls.filter((a) => a[1] === 'cat').map((a) => a[2]),
    [paths[1]],
  );
  assert.deepEqual(
    calls.filter((a) => a[1] === 'rm').map((a) => a[3]),
    paths,
  );
});
test('read errors and incomplete XML fail closed after bounded attempts', async () => {
  let dumps = 0;
  await assert.rejects(
    freshUi(async (args) => {
      if (args[1] === 'uiautomator') {
        dumps++;
        return { stdout: `UI hierarchy dumped to: ${args[3]}` };
      }
      return { stdout: '<hierarchy><node' };
    }),
    /ไม่ใช้พิกัดเก่า/,
  );
  assert.equal(dumps, 2);
});
