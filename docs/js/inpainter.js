/**
 * Inpainting on ONNX Runtime Web. Two interchangeable models, both fixed 512x512:
 *
 *   migan  MI-GAN (Picsart Research, ICCV 2023), 29 MB. Fast, soft on fine detail.
 *   lama   LaMa (Carve's ONNX export), 208 MB. Slower, but it continues thin
 *          structures such as glasses frames through the hole instead of
 *          smearing them.
 *
 * Everything here works on the 512x512 model window produced by watermark.js:
 * an RGBA byte array plus a 0/1 mask. The tensor builders are pure and tested in
 * Node. Mask polarity is the thing most likely to break silently (MI-GAN wants
 * 1 = keep, LaMa wants 1 = hole), and a flip fails as "badge still visible", not
 * as an exception.
 */

import { loadModel } from './model-cache.js';

export const SIZE = 512;
const N = SIZE * SIZE;

const sessions = new Map();   // model id -> { session, backend }
let current = null;           // model id in use

export function getBackend() { return sessions.get(current)?.backend ?? 'none'; }
export function getModelId() { return current; }
export function isReady() { return sessions.has(current); }

/**
 * Load a model and pick a backend. WebGPU is tried first; because some ops only
 * fail when they actually run, each candidate is warmed up with one inference
 * before it is accepted.
 */
export async function init(modelId, onProgress) {
  if (sessions.has(modelId)) { current = modelId; return; }
  if (typeof ort === 'undefined') {
    throw new Error('ONNX Runtime Web is not loaded (check the ort script tag).');
  }

  // The version comes from the <script> tag in index.html, so the two can never drift apart.
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
  ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);
  ort.env.wasm.simd = true;
  ort.env.webgpu.powerPreference = 'high-performance';
  ort.env.wasm.proxy = true;     // keep the UI responsive; needs cross-origin isolation, degrades gracefully
  ort.env.logLevel = 'warning';

  onProgress?.({ stage: 'Loading model…', done: 0, total: 0 });
  const bytes = await loadModel(modelId, onProgress);

  const errors = [];
  for (const ep of ['webgpu', 'wasm']) {
    try {
      onProgress?.({ stage: `Starting ${ep.toUpperCase()}…`, done: bytes.byteLength, total: bytes.byteLength });
      const session = await ort.InferenceSession.create(bytes.slice(), {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      await warmUp(session, modelId);
      sessions.set(modelId, { session, backend: ep });
      current = modelId;
      console.log(`[inpainter] ${modelId} on ${ep}`, session.inputNames, session.outputNames);
      return;
    } catch (e) {
      errors.push(`${ep}: ${e?.message || e}`);
      console.info(`[inpainter] ${modelId} on ${ep} failed, trying next:`, e?.message || e);
    }
  }
  throw new Error(`No usable ONNX backend for ${modelId}. ${errors.join(' | ')}`);
}

async function warmUp(session, modelId) {
  const rgba = new Uint8ClampedArray(N * 4).fill(128);
  const mask = new Uint8Array(N);
  mask.fill(1, N / 2, N / 2 + 2000);
  await runModel(session, modelId, rgba, mask);
}

/* ------------------------------------------------------------------ *
 * Inference
 * ------------------------------------------------------------------ */

/**
 * Fill the masked pixels of a 512x512 window.
 *
 * @param {Uint8ClampedArray} rgba  N*4 window pixels
 * @param {Uint8Array} mask         N, 1 = remove
 * @returns {Promise<Uint8ClampedArray>} N*4 network output (trust it only inside the mask)
 */
export async function fill(rgba, mask) {
  const entry = sessions.get(current);
  if (!entry) throw new Error('inpainter.init() has not completed');
  return runModel(entry.session, current, rgba, mask);
}

async function runModel(session, modelId, rgba, mask) {
  // Fresh typed arrays every call: ORT's proxy worker takes ownership of the
  // ArrayBuffer, so a reused one comes back detached.
  let feeds;
  if (modelId === 'lama') {
    const { image, holes } = buildLamaInputs(rgba, mask);
    feeds = {
      [session.inputNames[0]]: new ort.Tensor('float32', image, [1, 3, SIZE, SIZE]),
      [session.inputNames[1]]: new ort.Tensor('float32', holes, [1, 1, SIZE, SIZE]),
    };
  } else {
    feeds = {
      [session.inputNames[0]]: new ort.Tensor('float32', buildMIGANInput(rgba, mask), [1, 4, SIZE, SIZE]),
    };
  }
  const out = await session.run(feeds);
  const tensor = out[session.outputNames[0]];
  return modelId === 'lama' ? chwToRGBA(tensor.data, 1, 0) : chwToRGBA(tensor.data, 127.5, 127.5);
}

/* ------------------------------------------------------------------ *
 * Tensor math (pure — tested in Node)
 * ------------------------------------------------------------------ */

/**
 * MI-GAN's 4-channel input, channel-first:
 *   plane 0: keep - 0.5          (+0.5 = keep, -0.5 = hole)
 *   plane 1-3: RGB in [-1,1] * keep
 */
export function buildMIGANInput(rgba, mask) {
  const n = mask.length;
  const out = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) {
    const keep = mask[i] ? 0 : 1;
    const j = i * 4;
    out[i] = keep - 0.5;
    out[i + n] = (rgba[j] / 127.5 - 1) * keep;
    out[i + n * 2] = (rgba[j + 1] / 127.5 - 1) * keep;
    out[i + n * 3] = (rgba[j + 2] / 127.5 - 1) * keep;
  }
  return out;
}

/** LaMa: image in [0,1] (CHW) and a separate hole mask where 1 = remove. */
export function buildLamaInputs(rgba, mask) {
  const n = mask.length;
  const image = new Float32Array(3 * n);
  const holes = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    image[i] = rgba[j] / 255;
    image[i + n] = rgba[j + 1] / 255;
    image[i + n * 2] = rgba[j + 2] / 255;
    holes[i] = mask[i] ? 1 : 0;
  }
  return { image, holes };
}

/**
 * CHW float -> RGBA bytes: byte = value * scale + offset.
 * MI-GAN returns [-1,1] (scale 127.5, offset 127.5); LaMa already returns 0..255.
 */
export function chwToRGBA(chw, scale, offset) {
  const n = chw.length / 3;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = chw[i] * scale + offset;
    out[i * 4 + 1] = chw[i + n] * scale + offset;
    out[i * 4 + 2] = chw[i + n * 2] * scale + offset;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Compositing helpers
 * ------------------------------------------------------------------ */

/**
 * RGBA overlay that is the fill inside the mask, fading out over about a pixel
 * outside it, and fully transparent elsewhere. Drawn over the live frame, so
 * everything outside the badge keeps its original pixels.
 */
export function buildOverlay(filled, mask, box = maskBox(mask)) {
  const W = SIZE;
  const out = new Uint8ClampedArray(N * 4);
  if (!box) return out;
  // Only the mask's bounding box (+1 px) can be non-transparent.
  for (let y = box.y0; y <= box.y1; y++) {
    const y0 = y > 0 ? y - 1 : 0, y1 = y < W - 1 ? y + 1 : y;
    for (let x = box.x0; x <= box.x1; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x < W - 1 ? x + 1 : x;
      const i = y * W + x;
      // 3x3 box blur of the binary mask, boosted so the interior stays opaque
      const s = mask[y0 * W + x0] + mask[y0 * W + x] + mask[y0 * W + x1]
        + mask[y * W + x0] + mask[i] + mask[y * W + x1]
        + mask[y1 * W + x0] + mask[y1 * W + x] + mask[y1 * W + x1];
      if (!s) continue;
      const a = Math.min(1, s / 6);
      const j = i * 4;
      out[j] = filled[j];
      out[j + 1] = filled[j + 1];
      out[j + 2] = filled[j + 2];
      out[j + 3] = a * 255;
    }
  }
  return out;
}

const boxCache = new WeakMap();

/**
 * Bounding box of a mask grown by 1 px (the overlay's feather), clamped to the
 * window, or null for an empty mask. Cached per mask object, so the constant
 * settled mask is scanned once.
 */
export function maskBox(mask) {
  if (boxCache.has(mask)) return boxCache.get(mask);
  const W = SIZE;
  let x0 = W, y0 = W, x1 = -1, y1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const box = x1 < 0 ? null : {
    x0: Math.max(0, x0 - 1), y0: Math.max(0, y0 - 1), x1: Math.min(W - 1, x1 + 1), y1: Math.min(W - 1, y1 + 1),
  };
  boxCache.set(mask, box);
  return box;
}

/**
 * Median of the last three fills, inside the mask only. Consecutive fills of a
 * still badge differ mostly by model "boiling" on hair and fabric; the median
 * removes it without touching pixels outside the mask. Only valid while the
 * mask is constant (the settled state).
 *
 * @param {Uint8ClampedArray[]} ring  oldest first, exactly 3
 */
export function temporalMedian(ring, mask) {
  const out = new Uint8ClampedArray(ring[2]);
  const [d0, d1, d2] = ring;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    for (let c = 0; c < 3; c++) {
      const a = d0[p + c], b = d1[p + c], v = d2[p + c];
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      out[p + c] = v < lo ? lo : (v > hi ? hi : v);
    }
  }
  return out;
}

/**
 * Mean absolute difference between two fills inside the mask. When the picture
 * under the badge is moving, a median of three lags visibly, so smoothing is
 * only applied while this is small.
 */
export function patchMotion(a, b, mask, stride = 2) {
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i += stride) {
    if (!mask[i]) continue;
    const p = i * 4;
    sum += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    n += 3;
  }
  return n ? sum / n : 0;
}

/* ------------------------------------------------------------------ *
 * Fill reuse (speed)
 * ------------------------------------------------------------------ */

/**
 * Pixel indices of the band just outside the mask: `grown` minus `mask`.
 * The model's fill is driven by these pixels, so while they stay put the
 * previous fill is still right and the model does not need to run again.
 */
export function bandIndices(mask, grown) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (grown[i] && !mask[i]) n++;
  const out = new Int32Array(n);
  n = 0;
  for (let i = 0; i < mask.length; i++) if (grown[i] && !mask[i]) out[n++] = i;
  return out;
}

/**
 * How much the band changed between two RGBA windows.
 * Returns the mean absolute channel difference and the fraction of band pixels
 * that changed a lot (catches a small object moving in while the mean stays low).
 */
export function bandChange(a, b, band, bigDelta = 28) {
  if (!band.length) return { mean: 0, moved: 0 };
  let sum = 0, big = 0;
  for (let k = 0; k < band.length; k++) {
    const p = band[k] * 4;
    const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    sum += d;
    if (d > bigDelta * 3) big++;
  }
  return { mean: sum / (band.length * 3), moved: big / band.length };
}

/**
 * Speed presets. `maxReuse` is how many frames in a row may reuse one fill;
 * `mean` / `moved` are the bandChange limits under which reuse is allowed.
 */
export const SPEED_PRESETS = {
  quality:  { maxReuse: 0,  mean: 0,   moved: 0 },
  balanced: { maxReuse: 5,  mean: 2.5, moved: 0.01 },
  turbo:    { maxReuse: 15, mean: 5,   moved: 0.03 },
};

/** Should the previous fill be reused for this frame? Pure, tested. */
export function canReuse(change, age, preset) {
  return preset.maxReuse > 0 && age < preset.maxReuse
    && change.mean <= preset.mean && change.moved <= preset.moved;
}
