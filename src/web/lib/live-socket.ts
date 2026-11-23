/**
 * A WebSocket that keeps itself connected: it reconnects after drops with growing, jittered delays
 * (so a server restart isn't hit by every client at once), and straight away when the device comes
 * back online or the tab becomes visible. `url` is called on every attempt, so a reconnect can ask
 * for "events after the last one I saw".
 */
export function openLiveSocket(options: {
  url: () => string;
  onMessage: (data: unknown) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
}): { send: (data: unknown) => void; close: () => void } {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    clearTimeout(timer);
    options.onStatus?.('connecting');
    const ws = new WebSocket(new URL(options.url(), location.href.replace(/^http/, 'ws')));
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      options.onStatus?.('open');
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        options.onMessage(JSON.parse(e.data));
      } catch {
        // Ignore frames that aren't JSON.
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      options.onStatus?.('closed');
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  };

  const reconnectNow = () => {
    if (!stopped && !socket && document.visibilityState === 'visible') connect();
  };
  window.addEventListener('online', reconnectNow);
  document.addEventListener('visibilitychange', reconnectNow);
  connect();

  return {
    send: (data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
    },
    close: () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', reconnectNow);
      socket?.close(1000);
      socket = null;
    },
  };
}
