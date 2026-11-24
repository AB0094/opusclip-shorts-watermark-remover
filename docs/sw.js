/**
 * Service worker: offline shell + cross-origin isolation headers.
 *
 * GitHub Pages serves static files and cannot set COOP/COEP, so we re-emit
 * same-origin responses with the headers attached. That is what makes
 * SharedArrayBuffer available to ONNX Runtime's threaded WASM backend.
 *
 * Only same-origin GET responses are touched. The model (HuggingFace) and the
 * ONNX runtime (jsDelivr) are fetched cross-origin with CORS and pass through
 * untouched.
 */

const CACHE = 'opusclip-remover-v12';

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/geometry.js',
  'js/watermark.js',
  'js/inpainter.js',
  'js/model-cache.js',
  'js/demux.js',
  'js/video.js',
  'js/regions.js',
  'js/coi-bootstrap.js',
  'assets/wm-horizontal.png',
  'assets/wm-vertical.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => { /* a missing optional asset must not block install */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isolate(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // leave CDN / model alone
  if (req.headers.has('range')) return;              // let media seeking pass through
  if (/\.(mp4|webm|mov)$/i.test(url.pathname)) return; // media: never cached

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });

    if (cached) {
      // Stale-while-revalidate: serve instantly, refresh in the background.
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) await caches.put(req, fresh.clone());
        } catch { /* offline is fine */ }
      })());
      return isolate(cached);
    }

    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const copy = fresh.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
      }
      return isolate(fresh);
    } catch (err) {
      const fallback = await caches.match('index.html');
      if (fallback) return isolate(fallback);
      throw err;
    }
  })());
});
