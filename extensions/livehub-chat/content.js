/* global chrome */
(() => {
  const clientId = crypto.randomUUID();
  let busy = false,
    context = null,
    inFlightFrames = 0;
  async function relay(body) {
    return chrome.runtime.sendMessage({ type: 'relay', body: { ...body, clientId } });
  }
  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== 'livehub-page'
    )
      return;
    const data = event.data;
    if (data.type === 'state') context = data.context;
    else if (
      data.type === 'frame' &&
      context?.senderReady &&
      typeof data.frame === 'string' &&
      data.frame.length <= 1400000 &&
      inFlightFrames < 3
    ) {
      inFlightFrames++;
      void relay({ action: 'frame', ...context, frame: data.frame })
        .catch(() => {})
        .finally(() => inFlightFrames--);
    } else if (data.type === 'ack' && context && typeof data.jobId === 'string') {
      void relay({
        action: 'ack',
        ...context,
        jobId: data.jobId,
        accepted: data.accepted === true,
      }).catch(() => {});
    }
  });
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const { pairing } = await chrome.runtime.sendMessage({ type: 'config' });
      if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) {
        context = null;
        window.postMessage({ channel: 'livehub-extension', type: 'clear' }, location.origin);
        return;
      }
      window.postMessage(
        {
          channel: 'livehub-extension',
          type: 'configure',
          handle: pairing.handle,
          roomId: pairing.roomId,
        },
        location.origin,
      );
      if (!context || context.handle !== pairing.handle || context.roomId !== pairing.roomId)
        return;
      const result = await relay({ action: 'poll', ...context });
      if (result.job)
        window.postMessage(
          { channel: 'livehub-extension', type: 'send', job: result.job },
          location.origin,
        );
      await chrome.runtime.sendMessage({
        type: 'status',
        status: result.error || (context.senderReady ? 'เชื่อมต่อแล้ว' : 'รอแชทในห้อง LIVE'),
      });
    } catch {
      /* Disconnected extension/runtime: fail closed. */
    } finally {
      busy = false;
    }
  }
  setInterval(() => void poll(), 3000);
  void poll();
})();
