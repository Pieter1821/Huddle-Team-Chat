// The installable-app side of Huddle: the service worker, the browser's "install" offer, and turning
// push notifications on and off for this device.
import { useSyncExternalStore } from 'react';
import { api } from './api';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let installPrompt: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

let openHandler: ((url: string) => void) | null = null;
/** The signed-in app sets this, so a clicked notification moves it without reloading. */
export function onNotificationOpen(handler: ((url: string) => void) | null) {
  openHandler = handler;
}

/** Registers the service worker and keeps the browser's install offer for the Install button. */
export function startPwa() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err: unknown) => console.warn('service worker', err));
  // A clicked notification asks the open app to show that conversation.
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === 'huddle:open' && typeof e.data.url === 'string' && e.data.url.startsWith('/')) {
      if (openHandler) openHandler(e.data.url);
      else window.location.assign(e.data.url);
    }
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we offer it from Settings instead of the browser's own banner
    installPrompt = e as InstallPrompt;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    changed();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** True while the browser is offering to install Huddle as an app. */
export function useCanInstall() {
  return useSyncExternalStore(
    subscribe,
    () => installPrompt !== null,
    () => false,
  );
}

export async function install(): Promise<boolean> {
  if (!installPrompt) return false;
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  changed();
  return outcome === 'accepted';
}

export const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isAppleMobile = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export type PushSupport = 'supported' | 'install-first' | 'unsupported';

/** iPhones and iPads only allow notifications for web apps added to the Home Screen. */
export function pushSupport(): PushSupport {
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isAppleMobile() && !isInstalled()) return 'install-first';
  return capable ? 'supported' : 'unsupported';
}

async function registration() {
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  return (await registration()).pushManager.getSubscription();
}

const toBytes = (b64url: string) => {
  const s = atob(b64url.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** Saves this browser's subscription on the server (it's tied to this sign-in). */
async function save(sub: PushSubscription) {
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api('/push/subscriptions', { json: { endpoint: json.endpoint, keys: json.keys } });
}

/**
 * Asks permission (if needed) and subscribes. Returns the browser's answer, so the screen can
 * explain a "no" instead of failing silently.
 */
export async function enablePush(): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  const reg = await registration();
  const { publicKey } = await api<{ publicKey: string }>('/push/key');
  const serverKey = toBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for a different server key (e.g. after the secret changed) can't be used.
  const existingKey = sub?.options.applicationServerKey;
  if (sub && existingKey) {
    const bytes = new Uint8Array(existingKey);
    if (bytes.length !== serverKey.length || bytes.some((b, i) => b !== serverKey[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  await save(sub);
  return 'granted';
}

/** Re-saves an existing subscription (it may have been dropped on the server, e.g. after signing in again). */
export async function refreshPush() {
  const sub = await currentSubscription();
  if (sub && Notification.permission === 'granted') await save(sub);
  return sub;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/subscriptions/remove', { json: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe();
}

export async function testPush() {
  const sub = await currentSubscription();
  if (!sub) throw new Error('not subscribed');
  await api('/push/test', { json: { endpoint: sub.endpoint } });
}

/**
 * On sign-out the server drops this device's subscription with the session; the browser's copy is
 * removed too so the next person to sign in here starts clean. Never blocks signing out.
 */
export async function forgetPushOnSignOut() {
  try {
    const sub = await Promise.race([
      currentSubscription(),
      new Promise<null>((r) => setTimeout(() => r(null), 1000)),
    ]);
    await sub?.unsubscribe();
  } catch {
    // signing out matters more than tidying up
  }
}

/** Closes notifications for a conversation once you're looking at it. */
export function clearNotifications(conversationId: string) {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  void navigator.serviceWorker.ready
    .then((reg) => reg.getNotifications({ tag: conversationId }))
    .then((list) => list.forEach((n) => n.close()))
    .catch(() => undefined);
}
