// Local diagnostic only: report whether LIVE Studio's Chromium network panel
// exposes a room-create response. Never print or persist response contents.
const port = Number(process.env.LIVE_STUDIO_DEBUG_PORT ?? '9222');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid LIVE_STUDIO_DEBUG_PORT');
}

const base = `http://127.0.0.1:${port}`;
let targets;
try {
  const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  targets = await response.json();
} catch {
  console.error('LIVE Studio debugger is unavailable on the selected local port.');
  process.exitCode = 1;
}

if (targets) {
  const seen = new Set();
  const watch = (page) => {
    if (seen.has(page.id)) return;
    seen.add(page.id);
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const requests = new Set();
    let nextId = 1;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: nextId++, method: 'Network.enable' }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.method === 'Network.requestWillBeSent') {
        const url = message.params?.request?.url;
        if (typeof url === 'string' && /\/webcast\/room\/create\/?(?:\?|$)/.test(url)) {
          requests.add(message.params.requestId);
          const parsed = new URL(url);
          const body = message.params?.request?.postData;
          const headerNames = Object.keys(message.params?.request?.headers ?? {});
          console.log(
            `Room-create query keys: ${[...parsed.searchParams.keys()].sort().join(', ')}`,
          );
          if (typeof body === 'string') {
            console.log(
              `Room-create form keys: ${[...new URLSearchParams(body).keys()].sort().join(', ')}`,
            );
          }
          console.log(`Room-create header names: ${headerNames.sort().join(', ')}`);
        }
      }
      if (
        message.method === 'Network.requestWillBeSentExtraInfo' &&
        requests.has(message.params?.requestId)
      ) {
        const headerNames = Object.keys(message.params?.headers ?? {});
        console.log(`Room-create extra header names: ${headerNames.sort().join(', ')}`);
      }
      if (message.method === 'Network.responseReceived') {
        const url = message.params?.response?.url;
        if (typeof url === 'string' && /\/webcast\/room\/create\/?(?:\?|$)/.test(url)) {
          requests.add(message.params.requestId);
          console.log('Room-create response observed; checking field names.');
        }
      }
      if (
        message.method === 'Network.loadingFinished' &&
        requests.delete(message.params?.requestId)
      ) {
        socket.send(
          JSON.stringify({
            id: nextId++,
            method: 'Network.getResponseBody',
            params: { requestId: message.params.requestId },
          }),
        );
      }
      if (message.id && message.result?.body) {
        try {
          const raw = message.result.base64Encoded
            ? Buffer.from(message.result.body, 'base64').toString('utf8')
            : message.result.body;
          const body = JSON.parse(raw);
          const names = new Set();
          const visit = (value, depth = 0) => {
            if (!value || typeof value !== 'object' || depth > 8) return;
            for (const [key, child] of Object.entries(value)) {
              if (/^(room_id|stream_url|rtmp_push_url|stream_key)$/i.test(key)) names.add(key);
              if (typeof child === 'object') visit(child, depth + 1);
            }
          };
          visit(body);
          console.log(
            `Room-create response fields: ${[...names].sort().join(', ') || 'none detected'}`,
          );
        } catch {
          console.log('Room-create response could not be parsed as JSON.');
        }
      }
    });
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', () => {
      seen.delete(page.id);
    });
  };
  const refresh = async (list) => {
    const pages = list.filter(
      (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
    );
    for (const page of pages) watch(page);
    return pages.length;
  };
  const initialCount = await refresh(targets);
  if (!initialCount) {
    console.error('No inspectable LIVE Studio page was found.');
    process.exitCode = 1;
  } else {
    console.log(`Watching ${initialCount} local page(s) and new windows. No secrets are logged.`);
    setInterval(async () => {
      try {
        const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) await refresh(await response.json());
      } catch {
        // A transient debugger restart is expected while Studio changes windows.
      }
    }, 250);
  }
}
