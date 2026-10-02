/* global chrome */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith('https://shop.tiktok.com/streamer/live/product/dashboard') ||
    !['relay', 'config', 'status'].includes(message?.type)
  )
    return false;
  void (async () => {
    try {
      if (message.type === 'status') {
        await chrome.storage.session.set({ status: String(message.status).slice(0, 100) });
        respond({ ok: true });
        return;
      }
      const { pairing } = await chrome.storage.session.get('pairing');
      if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) {
        respond({ error: 'กรุณาจับคู่ส่วนเชื่อมใหม่' });
        return;
      }
      if (message.type === 'config') {
        respond({
          pairing: { handle: pairing.handle, roomId: pairing.roomId, expiresAt: pairing.expiresAt },
        });
        return;
      }
      // Hardcoded local destination. The page cannot choose a URL or access the token.
      const response = await fetch('http://localhost:3100/api/chat-bridge', {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(message.body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (response.status === 401) await chrome.storage.session.remove('pairing');
      respond(response.ok ? data : { error: data.error || 'ส่วนเชื่อมไม่พร้อม' });
    } catch {
      respond({ error: 'ติดต่อ Live Hub ไม่ได้' });
    }
  })();
  return true;
});
