// KBO 대시보드 Service Worker v8
const CACHE_NAME = 'kbo-v8';
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

// ── 백그라운드 주기적 싱크 (앱 닫혀도 동작, Android Chrome) ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'kia-hit-check') {
    e.waitUntil(checkKiaAndNotify());
  }
});

async function checkKiaAndNotify() {
  // 알림 설정 확인
  const notifyEnabled = await getStore('notifyEnabled');
  if (notifyEnabled !== 'true') return;

  // 오늘 날짜 (KST)
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const today = `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth()+1)}-${pad(kst.getUTCDate())}`;

  // 오늘 경기 일정에서 KIA LIVE 경기 찾기
  let kiaGame = null;
  try {
    const schRes = await fetch(`/api/kboScores?date=${today}`);
    if (!schRes.ok) return;
    const schData = await schRes.json();
    const games = schData?.games || [];
    kiaGame = games.find(g => g.status === 'LIVE' && (g.away === 'KIA' || g.home === 'KIA'));
  } catch(e) { return; }

  if (!kiaGame || !kiaGame.gameId) return;

  // 현재 이닝 중계 데이터 가져오기
  let relayData = null;
  try {
    const inn = kiaGame.inning || 1;
    const relRes = await fetch(`/api/kboScores?action=relay&gameId=${kiaGame.gameId}&inning=${inn}`);
    if (!relRes.ok) return;
    relayData = await relRes.json();
  } catch(e) { return; }

  if (!relayData) return;

  // 이미 알림 보낸 키 목록 가져오기
  const sentKeysRaw = await getStore('swNotifiedKeys') || '[]';
  let sentKeys;
  try { sentKeys = new Set(JSON.parse(sentKeysRaw)); } catch(e) { sentKeys = new Set(); }

  const newKeys = [];
  const notifications = [];

  const HIT_KEYWORDS = ['안타','홈런','볼넷','사구','몸에 맞는 공','적시타','장타','2루타','3루타','만루홈런'];
  const relays = relayData.textRelays || [];

  for (const item of relays) {
    const entries = [item, ...(item.textOptions || [])];
    for (const it of entries) {
      const title = it.title || it.text || '';
      const key = title + (it.seqno || item.seqno || '');
      if (!key || sentKeys.has(key)) continue;

      const isKiaAtBat = (kiaGame.away === 'KIA' && item.isAway) || (kiaGame.home === 'KIA' && !item.isAway);
      if (!isKiaAtBat) continue;

      if (HIT_KEYWORDS.some(kw => title.includes(kw))) {
        notifications.push({ title: '🐯 KIA 안타!', body: title, tag: 'kia-hit-' + key.slice(0,20) });
      }
      newKeys.push(key);
    }
  }

  // 새 키 저장 (최대 200개 유지)
  const allKeys = [...sentKeys, ...newKeys];
  if (allKeys.length > 200) allKeys.splice(0, allKeys.length - 200);
  await setStore('swNotifiedKeys', JSON.stringify(allKeys));

  // 알림 발송
  for (const n of notifications) {
    await self.registration.showNotification(n.title, {
      body: n.body, icon: '/icon-192.png', tag: n.tag,
      vibrate: [200, 100, 200], renotify: true,
    });
  }
}

// ── IndexedDB 간단 헬퍼 (sw 내부용) ──
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('kbo-sw-store', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv', { keyPath: 'k' });
    req.onsuccess = e => res(e.target.result);
    req.onerror = () => rej(req.error);
  });
}
async function getStore(key) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => res(req.result?.v ?? null);
      req.onerror = () => rej(req.error);
    });
  } catch(e) { return null; }
}
async function setStore(key, value) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ k: key, v: value });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch(e) {}
}

// ── message 핸들러 (SKIP_WAITING + LOCAL_NOTIFY + STORE_SYNC 통합) ──
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
    return;
  }
  // 앱에서 보낸 알림 키 동기화 (중복 방지)
  if (e.data?.type === 'SYNC_NOTIFIED_KEYS') {
    setStore('swNotifiedKeys', JSON.stringify([...e.data.keys]));
    return;
  }
  // 앱에서 notifyEnabled 상태 동기화
  if (e.data?.type === 'SYNC_NOTIFY_ENABLED') {
    setStore('notifyEnabled', e.data.enabled ? 'true' : 'false');
    return;
  }
});
