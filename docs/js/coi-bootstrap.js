/**
 * Cross-origin isolation bootstrap.
 *
 * ONNX Runtime's threaded WASM backend needs SharedArrayBuffer, which browsers
 * only expose when the document is cross-origin isolated. GitHub Pages cannot
 * send COOP/COEP headers, so a service worker adds them to every same-origin
 * response instead. The first visit registers the worker and reloads once; from
 * then on the page is isolated and `ort.env.wasm.numThreads > 1` actually works.
 *
 * If the browser has no service workers, nothing breaks — ORT falls back to
 * single-threaded WASM (roughly 5x slower) or WebGPU.
 */
(function () {
  if (!('serviceWorker' in navigator)) return;

  var KEY = 'coi-reloaded';

  navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
    if (window.crossOriginIsolated) return;

    var reload = function () {
      if (sessionStorage.getItem(KEY)) return;
      sessionStorage.setItem(KEY, '1');
      location.reload();
    };

    if (reg.active) {
      reload();
    } else {
      var worker = reg.installing || reg.waiting;
      if (worker) {
        worker.addEventListener('statechange', function () {
          if (worker.state === 'activated') reload();
        });
      }
    }
  }).catch(function (err) {
    console.warn('[coi] service worker registration failed:', err);
  });

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (window.crossOriginIsolated) return;
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, '1');
    location.reload();
  });
})();
