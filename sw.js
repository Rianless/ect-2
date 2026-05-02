// KBO 대시보드 Service Worker v7
const CACHE_NAME = 'kbo-v7';
const STATIC_ASSETS = ['/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(STATIC_ASSETS).catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const noCache = url.pathname === '/' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js');
  if (noCache) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}
  e.waitUntil(
    self.registration.showNotification(data.title || '🐯 KIA 타이거즈', {
      body: data.body || '',
      icon: '/icon-192.png',
      tag: data.tag || 'kia-alert',
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});

// message 핸들러 (SKIP_WAITING + LOCAL_NOTIFY 통합)
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING' || e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (e.data?.type === 'LOCAL_NOTIFY') {
    const { title = '🐯 KIA', body = '', tag = 'kia' } = e.data;
    self.registration.showNotification(title, {
      body, icon: '/icon-192.png', tag,
      vibrate: [200, 100, 200], renotify: true,
    });
  }
});
