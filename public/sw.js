// The service worker (design §13.1). It only shows the notices our worker
// sends ("Your Instamart history is in") and opens the app when one is
// tapped. It caches nothing: the site always loads fresh from the server.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'DhaniyaMirchi', {
        body: data.body || '',
        tag: data.tag,
        icon: '/icon.svg',
        badge: '/icon.svg',
        data: { url: data.url },
      }),
      // An open tab refreshes what it shows now, not at its next poll.
      self.clients
        .matchAll({ type: 'window' })
        .then((windows) => windows.forEach((w) => w.postMessage({ type: 'notice', tag: data.tag }))),
    ]),
  );
});

// Only ever a path on this site — a notice can't send anyone elsewhere.
const safePath = (url) => (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/');

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.focus().then((w) => (w && 'navigate' in w ? w.navigate(url) : w));
      return self.clients.openWindow(url);
    }),
  );
});
