// Notifications in the browser (design §13.1): register the service worker,
// ask permission, subscribe with our VAPID public key, and hand the
// subscription to our api. The worker sends; /sw.js shows.
import { api } from './api';

export type PushAvailability = 'ready' | 'denied' | 'needs-install' | 'unsupported';

export interface PushEnvironment {
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  iOS: boolean;
  standalone: boolean; // opened from the Home Screen
  permission: NotificationPermission | null;
}

// iPhones get web push only from a site added to the Home Screen (iOS 16.4+),
// so there the answer is "install first", not a button that can't work.
export function pushAvailability(env: PushEnvironment): PushAvailability {
  if (env.iOS && !env.standalone) return 'needs-install';
  if (!env.serviceWorker || !env.pushManager || !env.notification) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'ready';
}

export function currentPushEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notification: 'Notification' in window,
    iOS: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    standalone: window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
    permission: 'Notification' in window ? Notification.permission : null,
  };
}

// VAPID keys travel as base64url; the Push API wants bytes.
export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const SW_URL = '/sw.js';

// Already on in this browser? Re-sends the subscription so it belongs to
// whoever is signed in now.
export async function notificationsOn(): Promise<boolean> {
  if (pushAvailability(currentPushEnvironment()) !== 'ready' || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;
  await api('POST', '/api/push/subscribe', sub.toJSON());
  return true;
}

export type EnableResult = 'on' | 'denied' | 'dismissed';

export async function enableNotifications(): Promise<EnableResult> {
  const reg = await navigator.serviceWorker.register(SW_URL);
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'dismissed';
  const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/key');
  await navigator.serviceWorker.ready;
  const key = base64UrlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different server key (keys rotated) can't be
  // reused: drop it and subscribe afresh.
  if (sub && sub.options.applicationServerKey) {
    const existing = new Uint8Array(sub.options.applicationServerKey);
    if (existing.length !== key.length || existing.some((b, i) => b !== key[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', '/api/push/subscribe', sub.toJSON());
  return 'on';
}
