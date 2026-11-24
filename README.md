# OpusClip Shorts Watermark Remover

Removes the OpusClip badge from vertical shorts — **entirely in your browser**.

No upload, no account, no server-side compute. The page is static; the model runs
on your GPU (or CPU) via WebGPU / WASM. Your video never leaves the machine.

**Live:** https://quintessenlabs.github.io/opusclip-shorts-watermark-remover/

---

## Why a dedicated tool

The OpusClip badge is composited by OpusClip's renderer at a fixed anchor, so every
export puts it in the same place, with the same pixels. Measured across several
1080×1920 exports, the settled badge is **pixel-identical** and its core is pure
white (min(R,G,B) ≥ 250) whatever is behind it — fully opaque, so there is no
alpha to un-blend.

The badge has two parts: an animated intro (vertical "Created with" text, then the
logo slides up while "OpusClip" types in) and the settled horizontal badge that
stays to the end. **When** that happens differs from clip to clip (a trimmed clip
can have it from t = 0), so nothing here is keyed to the clock.

## How it works

```
MP4 ──mp4box──► samples ──VideoDecoder──► frame
                                            │
          512×512 window around the badge ◄─┘
             │   detect badge pixels (exact silhouettes, per frame)
             │   inpaint only those pixels  (MI-GAN or LaMa)
             ▼
   fill composited over the frame ──► VideoEncoder (H.264) ──► mp4-muxer ──► .mp4
   AAC audio samples are copied through untouched
```

- **Exact mask.** Two silhouettes measured by pixel consensus ship as PNGs
  (`static/assets/wm-*.png`). The mask is the logo and lettering *shape* grown by a
  couple of pixels — about half the area of the old bounding box (≈16 k px vs
  ≈33 k px at 1080 wide), so far less of the face under it gets reconstructed.
- **Per-frame detection, no timeline.** `watermark.js` looks at the pixels:
  *settled* when the horizontal silhouette is pure white (and sticky from then on),
  *intro* when the vertical text or the sliding logo icon is found, *none* when
  there is nothing to remove (the frame passes through untouched). A big white
  caption card is not mistaken for the badge, and the game's own white subtitles
  that cross the intro column are left alone.
- **Frame-exact, not real-time.** Every frame is decoded, cleaned and encoded in
  order with its own timestamp. The fill always belongs to the frame it is painted
  on, no frames are dropped, and the source frame rate (e.g. 60 fps) is kept.
- **Two models.**
  - *Fast · MI-GAN* (29 MB, default). Clean and quick, soft on fine detail.
  - *High quality · LaMa* (208 MB). Continues thin structures such as glasses
    frames through the hole instead of smearing them. Measured on an integrated
    Intel GPU: ~4.4 s per frame vs ~0.25 s for MI-GAN, so it is best for stills or
    on a strong GPU. It needs ONNX Runtime Web ≥ 1.30 (1.20.1 fails on its FFC
    layers under WebGPU and drops to WASM at ~5 s per frame).
- **Fill reuse (Speed setting).** Once the badge has settled, the model only needs
  to run again when the pixels in a thin band around the badge change. Each frame
  compares that band with the frame the model last ran on; if nothing moved, the
  previous fill is composited again and the model is skipped. *Balanced* (default)
  reuses a fill for up to 5 frames, *Turbo* for up to 15 with looser limits, and
  *Max quality* runs the model on every frame like before. On talking-head shorts
  this typically cuts model runs by 3 to 6 times, and the model is almost all of
  the processing time.
- **Hardware H.264 encoding** is requested first, with software as the fallback.
- **Extra areas.** Drag boxes on the preview over anything else you want gone
  (your own logo, a caption, a sticker). Each area gets its own model window and
  is filled on every frame, with the same fill reuse as the badge. Areas are
  stored as fractions of the frame, so one set applies to every file in a batch.
  The automatic OpusClip removal can be switched off to use areas only.
- **Batch mode.** Pick or drop several files; they run one after another with the
  model loaded once, each with its own download link, plus *Download all*.
- **Temporal smoothing** (optional): median of the last 3 fills while the badge is
  static and the picture under it is not moving.

## Honest limitations

The badge is opaque, so the pixels under it are gone. This **reconstructs** the
patch; it does not recover the original. Over flat walls, shadows and plain
clothing the result is invisible. Where the lettering crosses fine detail such as
glasses frames or eyebrows, MI-GAN can leave a faint smudge on some frames; LaMa
does noticeably better there.

The geometry is measured from OpusClip's standard 9:16 layout. A different export
style (another corner, another badge) needs new silhouettes in `static/assets/` and
new constants in `static/js/geometry.js`.

Inputs the browser cannot demux (WebM, phone videos rotated by metadata) fall back
to stepping a `<video>` element at an assumed 30 fps; that path is slower and only
frame-accurate to about 1/30 s.

## Run locally

```bash
node tools/serve.mjs          # http://localhost:8080
npm test                      # pure-logic regression tests (no browser, no model)
```

Any static server works. `tools/serve.mjs` additionally sets COOP/COEP so the
threaded WASM backend is enabled on localhost, matching production.

## Deploy

The site is plain static files in `static/` (mirrored to `docs/` for GitHub Pages).
Push to GitHub, then **Settings → Pages → Deploy from a branch → `main` / `/docs`**
(or `/static`). No build step.

Cross-origin isolation on GitHub Pages comes from `static/sw.js`, which re-emits
same-origin responses with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Without those headers
`SharedArrayBuffer` is unavailable and ONNX Runtime silently drops to
single-threaded WASM. WebGPU is unaffected either way.

## Privacy

- No telemetry, no analytics, no error reporting.
- No upload path exists in the code — check the Network tab while it runs.
- The only network requests are the pinned ONNX runtime and mp4 libraries
  (jsDelivr) and the pinned models (HuggingFace, SHA-256 verified), each fetched
  once and cached.

## Files

```
static/
  index.html            UI
  css/app.css
  assets/wm-horizontal.png  settled badge silhouette (measured)
  assets/wm-vertical.png    intro text silhouette (measured)
  js/geometry.js        badge geometry constants
  js/watermark.js       per-frame badge detector → exact mask (pure core, tested)
  js/inpainter.js       MI-GAN / LaMa inference + tensor math (pure, tested)
  js/model-cache.js     download, SHA-256 verify, IndexedDB cache
  js/demux.js           mp4box demux (video + AAC samples)
  js/video.js           decode → detect → inpaint → encode pipeline
  js/app.js             controller
  js/coi-bootstrap.js   service-worker registration for COOP/COEP
  sw.js                 offline shell + isolation headers
tools/
  test-math.mjs         regression tests (node, no browser)
  serve.mjs             dev server with COOP/COEP
```

## Credits

- [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) — Picsart Research, ICCV 2023
- [LaMa](https://github.com/advimman/lama) — Samsung AI; ONNX export by [Carve](https://huggingface.co/Carve/LaMa-ONNX)
- [ONNX Runtime Web](https://onnxruntime.ai/)
- [mp4box.js](https://github.com/gpac/mp4box.js) and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer)
- [lxfater/inpaint-web](https://github.com/lxfater/inpaint-web) — reference MI-GAN export
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) — the isolation pattern

MIT licensed.
