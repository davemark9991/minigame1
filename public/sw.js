// MINI GAME PWA Service Worker（游戏厅 + 管理后台共用）
const CACHE = 'mg-v1';
const SHELL = ['/', '/admin'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // API 等 POST 直接走网络
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;     // 接口绝不缓存
  // 页面/资源：网络优先，失败回退缓存（离线也能打开外壳）
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/admin') || caches.match('/')))
  );
});
