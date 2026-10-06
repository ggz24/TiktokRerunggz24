import { randomBytes } from 'node:crypto';
export function uiDumpSucceeded(stdout, path = '/sdcard/boxphone_ui.xml') {
  const value = String(stdout);
  return (
    !/ERROR|could not get idle state/i.test(value) &&
    value
      .split(/\r?\n/)
      .some(
        (line) =>
          line.trim() === `UI hierchary dumped to: ${path}` ||
          line.trim() === `UI hierarchy dumped to: ${path}`,
      )
  );
}
export async function freshUi(exec, { pause = async () => {}, attempts = 2 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const path = '/sdcard/boxphone_ui_' + randomBytes(12).toString('hex') + '.xml';
    try {
      const result = await exec(['shell', 'uiautomator', 'dump', path], 8000);
      if (!uiDumpSucceeded(result.stdout, path)) throw Error('No fresh UI dump');
      const { stdout } = await exec(['exec-out', 'cat', path], 8000);
      const xml = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout);
      if (!xml.includes('<hierarchy') || !xml.includes('<node') || !xml.includes('</hierarchy>'))
        throw Error('Incomplete UI dump');
      return xml;
    } catch {
    } finally {
      try {
        await exec(['shell', 'rm', '-f', path], 3000);
      } catch {}
    }
    if (i < attempts - 1) await pause(200);
  }
  throw Error(
    'อ่านหน้าจอปัจจุบันไม่ได้ จึงไม่ใช้พิกัดเก่าหรือประมาณตำแหน่ง กรุณาเปิด LIVE แล้วตรวจใหม่',
  );
}
