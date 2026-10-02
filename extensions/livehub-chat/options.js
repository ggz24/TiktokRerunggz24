/* global chrome */
document.querySelector('#save').addEventListener('click', async () => {
  const status = document.querySelector('#status');
  try {
    const p = JSON.parse(document.querySelector('#pairing').value);
    if (
      !/^[a-f0-9]{64}$/.test(p.token) ||
      !/^\d{8,24}$/.test(p.roomId) ||
      !/^[a-zA-Z0-9._]{1,80}$/.test(p.handle) ||
      !Number.isFinite(Date.parse(p.expiresAt)) ||
      Date.parse(p.expiresAt) <= Date.now()
    )
      throw new Error();
    await chrome.storage.session.set({
      pairing: { token: p.token, roomId: p.roomId, handle: p.handle, expiresAt: p.expiresAt },
      status: 'รอรีเฟรช TikTok Shop',
    });
    document.querySelector('#pairing').value = '';
    status.textContent = `จับคู่ @${p.handle} แล้ว กรุณารีเฟรช TikTok Shop`;
  } catch {
    status.textContent = 'ข้อมูลจับคู่ไม่ถูกต้องหรือหมดอายุ';
  }
});
document.querySelector('#clear').addEventListener('click', async () => {
  await chrome.storage.session.remove(['pairing', 'status']);
  document.querySelector('#status').textContent = 'หยุดเชื่อมต่อแล้ว';
});
void chrome.storage.session.get('status').then(({ status }) => {
  document.querySelector('#status').textContent = status || 'ยังไม่ได้จับคู่';
});
