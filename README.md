# OpusClip Shorts Watermark Remover

Removes the OpusClip badge from vertical shorts — **entirely in your browser**.

No upload, no account, no server-side compute. The page is static; the model runs
on your GPU (or CPU) via WebGPU / WASM. Your video never leaves the machine.

**Live:** https://quintessenlabs.github.io/opusclip-shorts-watermark-remover/

---

## Why a dedicated tool

The OpusClip badge is not placed by a model and it is not in a random spot. It is
composited by OpusClip's renderer at a fixed anchor, so every export puts it in
the same place:

```
1080 x 1920 reference frame
  settled badge    x=123  y=254  w=355  h=85
  intro animation  x=124  y=254  w=86   h=456   (vertical "Created with", first ~8.5 s)
```

Measured across four independent 1080×1920 exports: the badge silhouette was
**pixel-identical** (11,033 px, XOR = 0, IoU = 100%), and the badge core is pure
white regardless of the background behind it — i.e. fully opaque, so there is no
alpha to un-blend.

That makes the problem much smaller than a general watermark remover:

- no detection pass, no tracking, no drifting box;
- one static mask, scaled by frame width;
- a 512×512 crop around the badge is the model's native input size, so the pixels
  go in and come back with **zero resampling**.

## How it works

```
<video> ──drawImage(crop)──► 512×512 tile ──► MI-GAN (ONNX Runtime Web)
   │                                              │
   └──────────────► output canvas ◄───────────────┘
                          │
                    captureStream ──► MediaRecorder ──► MP4 / WebM
```

- **Mask**: fixed geometry from `static/js/geometry.js`, scaled by width, 2 px pad.
  The taller intro state is applied only for the first 8.5 s.
- **Inpaint**: MI-GAN (Picsart Research, ICCV 2023), 29 MB ONNX, SHA-256 pinned,
  cached in IndexedDB after the first download.
- **Temporal smoothing**: median of the last 3 fills inside the mask only, which
  removes the "boiling" that per-frame inpainting produces on hair and fabric.
- **Export**: real-time `MediaRecorder` with the audio routed through WebAudio, so
  audio stays locked to video even when inference is slower than playback.

## Honest limitations

The badge is opaque, so the pixels under it are gone. This **reconstructs** the
patch; it does not recover the original. Over flat walls, shadows and plain
clothing the result is invisible. Over fine hair, text or detailed faces it can
soften — that is the nature of inpainting, not a bug.

The mask geometry is measured from OpusClip's standard 9:16 layout. A different
export style (different corner, different badge) needs different constants in
`static/js/geometry.js`.

## Run locally

```bash
node tools/serve.mjs          # http://localhost:8080
npm test                      # pure-math regression tests
```

Any static server works. `tools/serve.mjs` additionally sets COOP/COEP so the
threaded WASM backend is enabled on localhost, matching production.

## Deploy

The site is plain static files in `static/`. Push to GitHub, then:

**Settings → Pages → Deploy from a branch → `main` / `/static`**

No build step, no dependencies, no CI required. `.nojekyll` is included so the
folder is served verbatim.

Cross-origin isolation on GitHub Pages comes from `static/sw.js`, which re-emits
same-origin responses with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Without those headers
`SharedArrayBuffer` is unavailable and ONNX Runtime silently drops to
single-threaded WASM (roughly 5× slower). WebGPU is unaffected either way.

## Privacy

- No telemetry, no analytics, no error reporting.
- No upload path exists in the code — check the Network tab while it runs.
- The only network requests are the pinned ONNX runtime (jsDelivr) and the pinned
  model (HuggingFace), both fetched once and cached.

## Files

```
static/
  index.html            UI
  css/app.css
  js/geometry.js        badge mask geometry (the measured constants)
  js/inpainter.js       MI-GAN inference + tensor math (pure, tested)
  js/model-cache.js     download, SHA-256 verify, IndexedDB cache
  js/video.js           decode → inpaint → record pipeline
  js/app.js             controller
  js/coi-bootstrap.js   service-worker registration for COOP/COEP
  sw.js                 offline shell + isolation headers
tools/
  test-math.mjs         regression tests (node, no browser)
  serve.mjs             dev server with COOP/COEP
```

## Credits

- [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) — Picsart Research, ICCV 2023
- [ONNX Runtime Web](https://onnxruntime.ai/)
- [lxfater/inpaint-web](https://github.com/lxfater/inpaint-web) — reference MI-GAN export
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) — the isolation pattern

MIT licensed.
