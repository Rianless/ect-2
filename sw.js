// 모든 캐시 삭제 후 즉시 종료
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  // 캐시 없이 항상 네트워크에서 직접 가져옴
  event.respondWith(fetch(event.request));
});
