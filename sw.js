const CACHE_NAME = 'ai-meeting-v3';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // We only cache GET requests
  if (event.request.method !== 'GET') return;
  // Exclude API calls like the Gemini API
  if (event.request.url.includes('googleapis.com')) return;
  
  // Network-First strategy
  event.respondWith(
    fetch(event.request).then((response) => {
      // If we got a valid response, clone it and cache it for offline use
      if(response && response.status === 200 && response.type === 'basic') {
          let responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
      }
      return response;
    }).catch(function() {
      // Fallback to cache if offline
      return caches.match(event.request);
    })
  );
});
