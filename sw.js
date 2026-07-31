const CACHE_NAME = 'ai-meeting-v4';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.tailwindcss.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // 1つでも失敗すると全体が落ちるので個別に入れる（CDNが不通でもインストールは成功させる）
      .then((cache) => Promise.all(
        ASSETS_TO_CACHE.map((url) => cache.add(url).catch((e) => console.warn('cache skip', url, e)))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Gemini API は常にネットワークへ
  if (event.request.url.includes('googleapis.com')) return;

  // Network-First（更新を取りこぼさない）／失敗時はキャッシュへ
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // basic だけでなく cors も保存する。Tailwind CDN が保存されず、
        // オフライン時に完全に無スタイルになっていた
        if (response && response.ok && (response.type === 'basic' || response.type === 'cors')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
