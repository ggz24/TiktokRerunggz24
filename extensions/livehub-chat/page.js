(() => {
  let config = null,
    socketRoom = null,
    socketOpen = false,
    activeSocket = null,
    pending = null;
  const dispatched = new Set();
  const announce = (data) =>
    window.postMessage({ channel: 'livehub-page', ...data }, location.origin);
  const chatInput = () => {
    const inputs = [
      ...document.querySelectorAll('textarea[placeholder],input[placeholder]'),
    ].filter(
      (el) => el.placeholder === 'Type something...' || el.placeholder === 'พิมพ์อะไรสักอย่าง...',
    );
    return inputs.length === 1 && !inputs[0].disabled && inputs[0].getClientRects().length
      ? inputs[0]
      : null;
  };
  const identityMatches = () =>
    config &&
    [...document.querySelectorAll('header span,header div,[role="banner"] span')].some(
      (el) => el.textContent?.trim() === config.handle,
    );
  const ready = () =>
    !!config && socketOpen && socketRoom === config.roomId && identityMatches() && !!chatInput();
  const state = () =>
    announce({
      type: 'state',
      context: config
        ? {
            roomId: socketRoom,
            handle: identityMatches() ? config.handle : '',
            senderReady: ready(),
          }
        : null,
    });
  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(Target, args) {
      const socket = Reflect.construct(Target, args);
      let url;
      try {
        url = new URL(String(args[0]));
      } catch {
        return socket;
      }
      if (
        url.hostname !== 'webcast-ws.tiktok.com' ||
        url.pathname !== '/webcast/im/ws_proxy/ws_reuse_supplement/'
      )
        return socket;
      const room = url.searchParams.get('room_id');
      socket.addEventListener('open', () => {
        activeSocket = socket;
        socketRoom = room;
        socketOpen = true;
        state();
      });
      socket.addEventListener('close', () => {
        if (activeSocket === socket) {
          socketOpen = false;
          state();
        }
      });
      socket.addEventListener('message', async (event) => {
        if (!config || room !== config.roomId || !ready()) return;
        try {
          const raw = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
          if (!(raw instanceof ArrayBuffer) || raw.byteLength > 1048576) return;
          const bytes = new Uint8Array(raw);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          announce({ type: 'frame', frame: btoa(binary) });
        } catch {
          /* Keep page WebSocket behavior unchanged. */
        }
      });
      return socket;
    },
  });
  function finish(id, accepted) {
    if (!pending || pending.id !== id) return;
    const job = pending;
    pending = null;
    clearTimeout(job.timer);
    announce({ type: 'ack', jobId: job.id, accepted: accepted === true });
  }
  function relevant(url, body) {
    if (!pending) return false;
    try {
      const u = new URL(url, location.href),
        data = JSON.parse(body);
      return u.origin === 'https://shop.tiktok.com' &&
        u.pathname === '/api/v1/streamer_desktop/message/chat' &&
        data.content === pending.text &&
        String(data.meta?.room_id) === pending.roomId
        ? pending.id
        : false;
    } catch {
      return false;
    }
  }
  const accepted = (data) => data?.code === 0 && [0, 1].includes(data.data?.punish);
  const originalOpen = XMLHttpRequest.prototype.open,
    originalSend = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    urls.set(this, String(url));
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const matches = relevant(urls.get(this), body);
    if (matches)
      this.addEventListener(
        'loadend',
        () => {
          try {
            finish(
              matches,
              this.status >= 200 &&
                this.status < 300 &&
                accepted(
                  this.responseType === 'json' ? this.response : JSON.parse(this.responseText),
                ),
            );
          } catch {
            finish(matches, false);
          }
        },
        { once: true },
      );
    return originalSend.call(this, body);
  };
  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const matches = relevant(
      typeof input === 'string' || input instanceof URL ? String(input) : input.url,
      init?.body,
    );
    const response = await nativeFetch.call(this, input, init);
    if (matches)
      void response
        .clone()
        .json()
        .then((data) => finish(matches, response.ok && accepted(data)))
        .catch(() => finish(matches, false));
    return response;
  };
  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.channel !== 'livehub-extension'
    )
      return;
    const data = event.data;
    if (data.type === 'clear') {
      config = null;
      state();
      return;
    }
    if (
      data.type === 'configure' &&
      /^[a-zA-Z0-9._]{1,80}$/.test(data.handle) &&
      /^\d{8,24}$/.test(data.roomId)
    ) {
      config = { handle: data.handle, roomId: data.roomId };
      state();
      return;
    }
    if (data.type !== 'send') return;
    const job = data.job;
    if (
      !job ||
      typeof job.id !== 'string' ||
      typeof job.text !== 'string' ||
      Array.from(job.text).length > 100 ||
      !job.text.trim() ||
      job.roomId !== config?.roomId ||
      dispatched.has(job.id)
    )
      return;
    dispatched.add(job.id);
    if (dispatched.size > 1000) dispatched.delete(dispatched.values().next().value);
    const input = chatInput();
    if (!ready() || pending || !input || input.value.trim()) {
      announce({ type: 'ack', jobId: job.id, accepted: false });
      return;
    }
    pending = { ...job, timer: setTimeout(() => finish(job.id, false), 15000) };
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, job.text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // TikTok's own form prepares the signed request. No Cookie or signature is copied.
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
  });
})();
