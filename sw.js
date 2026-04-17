// KBO 대시보드 Service Worker v4
const CACHE_NAME = 'kbo-v4';
// index.html은 캐시 안 함 - 항상 네트워크에서 받아야 SCH 데이터 최신 유지
const STATIC_ASSETS = ['/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(STATIC_ASSETS).catch(() => {})
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // index.html / 루트 / JS·HTML 파일 → 항상 네트워크 우선 (캐시 저장 안 함)
  const noCache = url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js');
  if (noCache) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // 나머지 (manifest 등) → 캐시 우선
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// 로컬 알림
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

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'LOCAL_NOTIFY') {
    const { title = '🐯 KIA', body = '', tag = 'kia' } = e.data;
    self.registration.showNotification(title, {
      body, icon: '/icon-192.png', tag,
      vibrate: [200, 100, 200], renotify: true,
    });
  }
});
