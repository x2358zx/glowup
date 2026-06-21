const CACHE_NAME = 'glowup-static-v1';
const MEDIA_CACHE_NAME = 'glowup-media-v1';

const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 安裝 Service Worker 並快取靜態資源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] 正在預快取靜態資源...');
        // 使用 cache.addAll，忽略部分失敗以防圖示尚未生成
        return Promise.allSettled(
          ASSETS.map(asset => {
            return cache.add(asset).catch(err => {
              console.warn(`[Service Worker] 無法快取資源: ${asset}`, err);
            });
          })
        );
      })
      .then(() => self.skipWaiting())
  );
});

// 激活 Service Worker 並清理舊快取
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME && key !== MEDIA_CACHE_NAME) {
            console.log('[Service Worker] 清理舊快取:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 攔截請求並提供快取優先策略
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. 處理特別的 /exercise-media/{Exercise_ID} 虛擬路徑
  if (url.pathname.includes('/exercise-media/')) {
    event.respondWith(
      caches.open(MEDIA_CACHE_NAME).then(cache => {
        // 從 pathname 提取 Exercise_ID (相容 GitHub Pages 子資料夾路徑)
        const match = url.pathname.match(/\/exercise-media\/([^\/]+)/);
        const exerciseId = match ? match[1] : '';
        const cacheKey = `/exercise-media/${exerciseId}`;

        return cache.match(cacheKey).then(cachedResponse => {
          if (cachedResponse) {
            console.log(`[Service Worker] 命中動作媒體快取: ${cacheKey}`);
            return cachedResponse;
          }

          // 如果快取中沒有且在線，則嘗試從網絡抓取
          return fetch(event.request).then(networkResponse => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(cacheKey, networkResponse.clone());
            }
            return networkResponse;
          }).catch(err => {
            console.warn(`[Service Worker] 離線且無快取媒體: ${cacheKey}`);
            return new Response('離線狀態且此動作影片尚未快取', {
              status: 404,
              statusText: 'Offline and uncached'
            });
          });
        });
      })
    );
    return;
  }

  // 2. 預設靜態資源快取優先，其餘網路優先
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).catch(err => {
        // 離線回退
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Promise.reject(err);
      });
    })
  );
});
