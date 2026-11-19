/**
 * MI-GAN inpainting on ONNX Runtime Web.
 *
 * Model: MI-GAN (Picsart Research, ICCV 2023). Fixed 512x512 input, 4 channels,
 * float32. The preprocessing below mirrors Picsart's official `demo.py`; the
 * mask polarity in particular is inverted relative to LaMa, and getting it
 * backwards inpaints everything *except* the hole. The pure functions are
 * exported so tools/test-tensor.mjs can regression-test them in Node.
 *
 * Two calling conventions:
 *   inpaint(image, mask)              one-shot, re-plans every call (images)
 *   plan + inpaintFrame(...)          video path: plan once, reuse per frame
 */

import { loadModel } from './model-cache.js';

const MODEL_SIZE = 512;
const READBACK = { willReadFrequently: true };
const MASK_THRESHOLD = 64;   // mask alpha above this = "remove this pixel"
const FEATHER = 5;           // px of soft edge, in crop space

let session = null;
let backend = 'none';

export function getBackend() { return backend; }
export function isReady() { return session !== null; }

export async function init(onProgress) {
  if (session) return session;
  if (typeof ort === 'undefined') {
    throw new Error('ONNX Runtime Web is not loaded (check the ort script tag).');
  }

  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 4);
  ort.env.wasm.simd = true;
  ort.env.webgpu.powerPreference = 'high-performance';
  // Worker-proxied execution keeps the UI responsive during a long clip.
  // Requires cross-origin isolation; without it ORT falls back gracefully.
  ort.env.wasm.proxy = true;
  ort.env.logLevel = 'warning';

  onProgress?.({ stage: 'Loading model…', done: 0, total: 0 });
  const bytes = await loadModel(onProgress);

  for (const ep of ['webgpu', 'wasm']) {
    try {
      onProgress?.({ stage: `Starting ${ep.toUpperCase()}…`, done: bytes.byteLength, total: bytes.byteLength });
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      backend = ep;
      console.log('[inpainter] backend:', ep, 'inputs:', session.inputNames, 'outputs:', session.outputNames);
      return session;
    } catch (e) {
      console.info(`[inpainter] ${ep} unavailable, trying next:`, e?.message || e);
    }
  }
  throw new Error('No usable ONNX backend (tried WebGPU and WASM).');
}

/* ------------------------------------------------------------------ *
 * Planning: crop geometry that does not depend on the frame
 * ------------------------------------------------------------------ */

/**
 * Work out the square crop around the mask once, so the video path does not
 * rescan a 2 megapixel mask on every frame.
 *
 * @param {ImageData} maskData
 * @param {{context?:number}} [opts]
 * @returns {{x:number,y:number,size:number,w:number,h:number}|null}
 */
export function createPlan(maskData, opts = {}) {
  const bbox = findMaskBbox(maskData);
  if (!bbox) return null;

  const W = maskData.width, H = maskData.height;
  const context = opts.context ?? 3.0;
  const maskDim = Math.max(bbox.w, bbox.h);
  const size = Math.min(Math.max(MODEL_SIZE, Math.round(maskDim * context)), W, H);

  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const x = Math.max(0, Math.min(W - size, Math.round(cx - size / 2)));
  const y = Math.max(0, Math.min(H - size, Math.round(cy - size / 2)));

  return { x, y, size, w: W, h: H };
}

/** One-shot convenience wrapper (used for images). */
export async function inpaint(imageData, maskData, opts = {}) {
  const plan = createPlan(maskData, opts);
  if (!plan) return imageData;
  return inpaintFrame(imageData, maskData, plan, opts);
}

/**
 * Inpaint a full frame using a precomputed plan (image path).
 *
 * @param {ImageData} imageData full frame
 * @param {ImageData} maskData  same size; alpha>64 marks removal
 * @param {{x:number,y:number,size:number,w:number,h:number}} plan
 * @param {{passes?:number}} [opts] 1 = normal, 2 = refine pass
 * @returns {Promise<ImageData>}
 */
export async function inpaintFrame(imageData, maskData, plan, opts = {}) {
  if (!session) throw new Error('inpainter.init() has not completed');
  const passes = opts.passes ?? 1;

  let current = imageData;
  for (let p = 0; p < passes; p++) {
    const size = p === 0 ? plan.size : Math.max(MODEL_SIZE, Math.round(plan.size / 2));
    const x = Math.max(0, Math.min(plan.w - size, plan.x));
    const y = Math.max(0, Math.min(plan.h - size, plan.y));
    current = await runPass(current, maskData, { x, y, size, w: plan.w, h: plan.h });
  }
  return current;
}

/**
 * Prepare a reusable runner for a fixed crop + mask (video path).
 *
 * Everything that does not change between frames is computed once here: the
 * feathered alpha channel, the mask polarity, the blend bounds, and the float
 * input buffer. Per frame we then do two linear passes over 512x512 (tensor in,
 * RGBA out) and one blend over the mask box — no canvas round-trips, no blur,
 * no 2 MP readback. That is what keeps the recorder's wall clock honest.
 *
 * @param {ImageData} cropMask  mask cropped to the model window
 * @param {number} size         crop edge length
 * @param {{passes?:number}} [defaults]
 */
export function createCropRunner(cropMask, size, defaults = {}) {
  const bbox = findMaskBbox(cropMask);
  if (!bbox) return null;

  const N = size * size;
  const native = size === MODEL_SIZE;
  const alpha = native ? buildFeatherAlpha(cropMask, size) : null;
  const maskBytes = cropMask.data;

  const bx0 = bbox.x, by0 = bbox.y;
  const bx1 = Math.min(size, bbox.x + bbox.w);
  const by1 = Math.min(size, bbox.y + bbox.h);

  async function inferOnce(pixels, passes) {
    const inputName = (session.inputNames && session.inputNames[0]) || 'input';

    for (let p = 0; p < passes; p++) {
      // A fresh buffer per run: ORT's proxy worker takes ownership of the
      // ArrayBuffer, so a reused one comes back detached (length 0).
      const input = new Float32Array(4 * N);
      // Build the 4-channel tensor straight from the frame bytes.
      for (let i = 0; i < N; i++) {
        const keep = maskBytes[i * 4 + 3] > MASK_THRESHOLD ? 0 : 1;
        const j = i * 4;
        input[i] = keep - 0.5;
        input[i + N] = (pixels[j] / 127.5 - 1) * keep;
        input[i + N * 2] = (pixels[j + 1] / 127.5 - 1) * keep;
        input[i + N * 3] = (pixels[j + 2] / 127.5 - 1) * keep;
      }

      const output = await session.run({
        [inputName]: new ort.Tensor('float32', input, [1, 4, MODEL_SIZE, MODEL_SIZE]),
      });
      const tensor = output[Object.keys(output)[0]];
      const chw = tensor.data;
      const outH = tensor.dims[2] || MODEL_SIZE;
      const outW = tensor.dims[3] || MODEL_SIZE;

      // Blend the network output into a copy of the frame, mask box only.
      const rgba = new Uint8ClampedArray(pixels);
      if (native && outW === size && outH === size) {
        for (let y = by0; y < by1; y++) {
          let i = y * size + bx0;
          for (let x = bx0; x < bx1; x++, i++) {
            const a = alpha[i];
            if (a <= 0) continue;
            const j = i * 4;
            rgba[j] = clamp255(chw[i] * 127.5 + 127.5) * a + rgba[j] * (1 - a);
            rgba[j + 1] = clamp255(chw[i + N] * 127.5 + 127.5) * a + rgba[j + 1] * (1 - a);
            rgba[j + 2] = clamp255(chw[i + N * 2] * 127.5 + 127.5) * a + rgba[j + 2] * (1 - a);
          }
        }
        pixels = rgba;
      } else {
        // Rare: crop is not 512². Fall back to the canvas path for this pass.
        const inferResult = new ImageData(miganOutputToRGBA(chw, outW, outH), outW, outH);
        const fullResult = (outW === size && outH === size) ? inferResult : resizeImageData(inferResult, size);
        pixels = composite(new ImageData(pixels, size, size), fullResult, cropMask, 0, 0, size, size, FEATHER).data;
      }
    }
    return pixels;
  }

  return {
    size,
    bbox,
    mask: cropMask,
    /**
     * @param {ImageData} cropImage 512x512 frame crop (or size²)
     * @param {{passes?:number}} [opts]
     * @returns {Promise<ImageData>}
     */
    async run(cropImage, opts = {}) {
      if (!session) throw new Error('inpainter.init() has not completed');
      const passes = opts.passes ?? defaults.passes ?? 1;
      const out = await inferOnce(cropImage.data, passes);
      return new ImageData(out, size, size);
    },
  };
}

/**
 * Feathered alpha for the mask, computed once per crop.
 *
 * Binarise first, blur second: using the raw mask alpha would rebuild the
 * watermark at partial opacity along the edge.
 */
function buildFeatherAlpha(cropMask, size) {
  const binary = new ImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = cropMask.data[i * 4 + 3] > MASK_THRESHOLD ? 255 : 0;
    binary.data[i * 4] = v;
    binary.data[i * 4 + 1] = v;
    binary.data[i * 4 + 2] = v;
    binary.data[i * 4 + 3] = v;
  }

  const { c, ctx } = canvasOf(size, size);
  ctx.putImageData(binary, 0, 0);

  const blurred = canvasOf(size, size);
  blurred.ctx.filter = `blur(${FEATHER}px)`;
  blurred.ctx.drawImage(c, 0, 0);
  blurred.ctx.filter = 'none';
  const px = blurred.ctx.getImageData(0, 0, size, size).data;

  const alpha = new Float32Array(size * size);
  for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3] / 255;
  return alpha;
}

function clamp255(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

async function runPass(imageData, maskData, crop) {
  const { x, y, size, w: W, h: H } = crop;

  const cropImage = cropImageData(imageData, x, y, size);
  const cropMask = cropImageData(maskData, x, y, size);
  const inferImage = resizeImageData(cropImage, MODEL_SIZE);
  const inferMask = resizeImageData(cropMask, MODEL_SIZE);

  const inputName = (session.inputNames && session.inputNames[0]) || 'input';
  const feeds = {
    [inputName]: new ort.Tensor('float32', buildMIGANInput(inferImage, inferMask), [1, 4, MODEL_SIZE, MODEL_SIZE]),
  };

  const output = await session.run(feeds);
  const tensor = output[Object.keys(output)[0]];
  const outH = tensor.dims[2] || MODEL_SIZE;
  const outW = tensor.dims[3] || MODEL_SIZE;

  const inferResult = new ImageData(miganOutputToRGBA(tensor.data, outW, outH), outW, outH);
  const cropResult = (outW === size && outH === size) ? inferResult : resizeImageData(inferResult, size);

  return composite(imageData, cropResult, cropMask, x, y, W, H, FEATHER);
}

/* ------------------------------------------------------------------ *
 * Tensor math (pure — tested in Node)
 * ------------------------------------------------------------------ */

/**
 * MI-GAN's 4-channel input, channel-first:
 *   plane 0: mask - 0.5          (0.5 = keep, -0.5 = hole)
 *   plane 1: R_norm * mask
 *   plane 2: G_norm * mask
 *   plane 3: B_norm * mask
 * where mask is 1.0 outside the hole and 0.0 inside it.
 */
export function buildMIGANInput(imageData, maskData) {
  const { width, height, data: img } = imageData;
  const maskBytes = maskData.data;
  const size = width * height;
  const out = new Float32Array(4 * size);

  for (let i = 0; i < size; i++) {
    const masked = maskBytes[i * 4 + 3] > MASK_THRESHOLD ? 0.0 : 1.0;
    const r = (img[i * 4]     / 255) * 2 - 1;
    const g = (img[i * 4 + 1] / 255) * 2 - 1;
    const b = (img[i * 4 + 2] / 255) * 2 - 1;

    out[i]                = masked - 0.5;
    out[i + size]         = r * masked;
    out[i + size * 2]     = g * masked;
    out[i + size * 3]     = b * masked;
  }
  return out;
}

/** [-1, 1] CHW float output -> RGBA bytes. */
export function miganOutputToRGBA(chw, w, h) {
  const size = w * h;
  const out = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    out[i * 4]     = Math.max(0, Math.min(1, chw[i]            * 0.5 + 0.5)) * 255;
    out[i * 4 + 1] = Math.max(0, Math.min(1, chw[i + size]     * 0.5 + 0.5)) * 255;
    out[i * 4 + 2] = Math.max(0, Math.min(1, chw[i + size * 2] * 0.5 + 0.5)) * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Bounding box of mask pixels, or null when the mask is empty. */
export function findMaskBbox(maskData) {
  const { width, height, data } = maskData;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[(row + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ------------------------------------------------------------------ *
 * Canvas plumbing
 * ------------------------------------------------------------------ */

function canvasOf(w, h) {
  const c = new OffscreenCanvas(w, h);
  return { c, ctx: c.getContext('2d', READBACK) };
}

function cropImageData(src, x, y, size) {
  const { c, ctx } = canvasOf(size, size);
  const s = canvasOf(src.width, src.height);
  s.ctx.putImageData(src, 0, 0);
  ctx.drawImage(s.c, x, y, size, size, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

function resizeImageData(src, size) {
  const { c, ctx } = canvasOf(size, size);
  const s = canvasOf(src.width, src.height);
  s.ctx.putImageData(src, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s.c, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Paste the filled crop back, replacing only masked pixels.
 *
 * The mask is binarised first and feathered second. Using the raw mask alpha
 * would blend the watermark back in at partial opacity — the classic
 * "still visible" bug.
 */
function composite(original, filled, cropMask, x, y, W, H, feather) {
  const size = filled.width;

  const binary = new ImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = cropMask.data[i * 4 + 3] > MASK_THRESHOLD ? 255 : 0;
    binary.data[i * 4] = v;
    binary.data[i * 4 + 1] = v;
    binary.data[i * 4 + 2] = v;
    binary.data[i * 4 + 3] = v;
  }

  const b = canvasOf(size, size);
  b.ctx.putImageData(binary, 0, 0);

  const f = canvasOf(size, size);
  f.ctx.filter = `blur(${feather}px)`;
  f.ctx.drawImage(b.c, 0, 0);
  f.ctx.filter = 'none';
  const featherMask = f.ctx.getImageData(0, 0, size, size);

  const out = new Uint8ClampedArray(original.data);
  for (let yy = 0; yy < size; yy++) {
    const oy = y + yy;
    if (oy < 0 || oy >= H) continue;
    for (let xx = 0; xx < size; xx++) {
      const ox = x + xx;
      if (ox < 0 || ox >= W) continue;
      const a = featherMask.data[(yy * size + xx) * 4 + 3] / 255;
      if (a <= 0) continue;
      const dst = (oy * W + ox) * 4;
      const src = (yy * size + xx) * 4;
      out[dst]     = filled.data[src]     * a + out[dst]     * (1 - a);
      out[dst + 1] = filled.data[src + 1] * a + out[dst + 1] * (1 - a);
      out[dst + 2] = filled.data[src + 2] * a + out[dst + 2] * (1 - a);
      out[dst + 3] = 255;
    }
  }
  return new ImageData(out, W, H);
}

/**
 * Temporal median of the filled pixels only.
 *
 * MI-GAN is deterministic, so consecutive fills differ mostly where the
 * background changed. Keeping a small ring of past fills and taking the median
 * per pixel removes the "boiling" that per-frame inpainting otherwise produces
 * on hair and fabric, without touching anything outside the mask.
 *
 * @param {ImageData[]} ring  oldest first, newest last
 * @param {ImageData} maskData
 * @param {{x:number,y:number,w:number,h:number}} [bbox]  mask bounds, to skip empty rows
 */
export function temporalMedian(ring, maskData, bbox) {
  const n = ring.length;
  if (n < 3) return ring[n - 1];
  const ref = ring[n - 1];
  const { width: W, height: H } = ref;
  const out = new Uint8ClampedArray(ref.data);
  const d0 = ring[0].data, d1 = ring[1].data, d2 = ring[2].data;

  const x0 = bbox ? bbox.x : 0;
  const y0 = bbox ? bbox.y : 0;
  const x1 = bbox ? Math.min(W, bbox.x + bbox.w) : W;
  const y1 = bbox ? Math.min(H, bbox.y + bbox.h) : H;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      if (maskData.data[i * 4 + 3] <= MASK_THRESHOLD) continue;
      const p = i * 4;
      for (let c = 0; c < 3; c++) {
        const a = d0[p + c], b = d1[p + c], c2 = d2[p + c];
        // median of three, branch-free
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        out[p + c] = c2 < lo ? lo : (c2 > hi ? hi : c2);
      }
    }
  }
  return new ImageData(out, W, H);
}

/**
 * Mean absolute difference between two fills, sampled inside the mask box.
 *
 * Used to decide whether temporal smoothing is safe. When the background under
 * the badge is moving, averaging three fills lags visibly, so the median is only
 * applied while the patch is essentially still.
 *
 * @returns {number} 0..255-ish
 */
export function patchMotion(a, b, bbox, step = 2) {
  if (!bbox) return 255;
  const W = a.width;
  let sum = 0;
  let n = 0;
  const y1 = Math.min(a.height, bbox.y + bbox.h);
  const x1 = Math.min(W, bbox.x + bbox.w);

  for (let y = bbox.y; y < y1; y += step) {
    for (let x = bbox.x; x < x1; x += step) {
      const p = (y * W + x) * 4;
      sum += Math.abs(a.data[p] - b.data[p])
           + Math.abs(a.data[p + 1] - b.data[p + 1])
           + Math.abs(a.data[p + 2] - b.data[p + 2]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}

/**
 * Cut the patched region out of an inpainted crop.
 *
 * The video path repaints the frame at display rate but can only afford to run
 * the model a few times a second on a CPU backend. Pasting the whole 512x512
 * crop would freeze a 512px square between model runs, so instead we keep only
 * the mask box and paste that small image over the live frame. Everything
 * outside stays at full frame rate.
 *
 * @returns {{data:ImageData, x:number, y:number, w:number, h:number}}
 */
export function extractPatch(filled, bbox, crop) {
  if (!bbox) return null;
  // Only the mask box itself: everything the patch covers must be content the
  // badge hid. Widening it would paste stale frames over live pixels.
  const pad = 1;
  const x = Math.max(0, bbox.x - pad);
  const y = Math.max(0, bbox.y - pad);
  const x2 = Math.min(crop.size, bbox.x + bbox.w + pad);
  const y2 = Math.min(crop.size, bbox.y + bbox.h + pad);
  const w = x2 - x;
  const h = y2 - y;

  const out = new ImageData(w, h);
  for (let yy = 0; yy < h; yy++) {
    const src = ((y + yy) * crop.size + x) * 4;
    out.data.set(filled.data.subarray(src, src + w * 4), yy * w * 4);
  }
  return { data: out, x: crop.x + x, y: crop.y + y, w, h };
}
