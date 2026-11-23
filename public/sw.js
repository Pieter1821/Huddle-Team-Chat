// Huddle's service worker: shows push notifications, opens the right conversation when one is
// clicked, and shows a small offline page instead of the browser's error when there's no network.
// It caches nothing else, so a new version of Huddle is always picked up on the next load.

const OFFLINE_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Huddle</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#151515;color:#fffbeb;
font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}a{display:inline-block;margin-top:16px;
border-radius:900px;background:#00b18c;color:#151515;font:600 15px system-ui;padding:10px 20px;
text-decoration:none}</style>
<div><h1 style="font-size:22px;margin:0 0 8px">You’re offline</h1>
<p style="margin:0;color:#c9c5b9">Huddle will be here as soon as you’re connected again.</p>
<a href="">Try again</a></div></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Only page loads are handled, and only when the network fails; everything else goes straight to
// the network as if there were no service worker.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          },
        }),
    ),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // An unreadable push still shows something, so the browser never sees a silent one.
  }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(
    (async () => {
      // Someone already looking at this very conversation doesn't need a notification for it.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const looking = windows.some(
        (w) => w.focused && w.visibilityState === 'visible' && data.tag && new URL(w.url).pathname.startsWith(`/c/${data.tag}`),
      );
      if (looking) return;
      await self.registration.showNotification(typeof data.title === 'string' ? data.title : 'Huddle', {
        body: typeof data.body === 'string' ? data.body : 'You have a new message.',
        icon: '/brand/huddle-mark-192.png',
        badge: '/brand/huddle-mark-64.png',
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        renotify: Boolean(data.tag),
        data: { url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        // The app moves to the conversation itself, without reloading.
        open.postMessage({ type: 'huddle:open', url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
