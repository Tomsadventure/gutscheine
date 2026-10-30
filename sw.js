/* Offline: hält alle Dateien eines App-Stands auf dem Gerät. VERSION und FILES setzt Scripts/bauen.mjs ein. */
const VERSION = '2026-10-30-9851435';
const FILES = ["./","app.js","daten.js","firebase-config.js","fonts/Nunito-Bold.woff2","fonts/Nunito-ExtraBold.woff2","fonts/Nunito-Regular.woff2","fonts/OFL.txt","icons/apple-touch-icon.png","icons/favicon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","ki.js","lib/firebase/LICENSE.txt","lib/firebase/firebase.js","lib/zxing/LICENSE.txt","lib/zxing/reader.js","lib/zxing/writer.js","lib/zxing/zxing_reader.wasm","lib/zxing/zxing_writer.wasm","manifest.webmanifest","scan-worker.js","scanner.js","strichcode.js","style.css","wolke.js"];
const CACHE = 'gutscheine-' + VERSION;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('gutscheine-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true })).then(hit => hit || fetch(req).then(res => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./', { ignoreSearch: true }) : Response.error())))
  );
});
