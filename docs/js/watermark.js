/**
 * Badge detector: decides, from the pixels of each frame, which pixels to remove.
 *
 * Everything runs on a fixed 512x512 "model grid": a window of the frame centred
 * on the badge zone (resampled only when the frame is much larger than 1080 px
 * wide). The detector never looks at the clock, so it works on any clip,
 * trimmed or not.
 *
 *   settled   the horizontal badge is up. The mask is the exact logo silhouette
 *             grown by a couple of pixels, identical every frame.
 *   anim      the intro is playing. The mask is whatever near-white pixels sit
 *             inside the known intro geometry.
 *   none      nothing to remove. The frame passes through untouched.
 *
 * The settled state is recognised by the silhouette itself being pure white
 * (every measured export has min(R,G,B) >= 250 inside it) and, once seen, is
 * sticky: the badge never goes away again. A big white caption card behind the
 * zone is not mistaken for the badge, because a card is also white around the
 * silhouette, while the badge is surrounded by picture.
 *
 * The pure core (createDetectorCore) works on typed arrays and is tested in Node;
 * createDetector adds the canvas work needed to rasterise the PNG silhouettes.
 */

import {
  REFERENCE_WIDTH, ZONE, INTRO_STRIP, TEMPLATE_H_URL, TEMPLATE_V_URL,
} from './geometry.js';

export const MODEL_SIZE = 512;

const WHITE_SETTLED = 235;   // min(R,G,B) that counts as "badge white" for the settled test
const WHITE_ANIM = 215;      // looser: the intro text is thin and anti-aliased
const SETTLE_SCORE = 0.9;    // share of the silhouette core that must be white
const RING_LIMIT = 0.85;     // white share of the surrounding ring above which it is a card, not a badge
const SETTLE_FRAMES = 2;     // consecutive frames before the settled state sticks
const STRIP_LIMIT = 0.7;     // white share of the intro column above which the frame is a flat white card
                             // (a caption card overlapping the column measured 0.37 on real footage)
const ANIM_MIN_PIXELS = 20;
const V_EVIDENCE = 30;       // white px on the first letters of the vertical text that start the intro state
const H_EVIDENCE = 120;      // white px on the horizontal logo that start it, for clips cut mid-intro
// Evidence that the badge is starting must be *precise*: of the white pixels near
// a silhouette, this share has to sit on the silhouette itself. Lettering is white
// only on its glyphs; a caption card overlapping the zone is white all around them.
const PRECISION = 0.6;
const H_RING_EVIDENCE = 0.3; // ...and, for the horizontal logo, the ring around it must be mostly NOT white
const ICON_SCORE = 0.85;    // share of the logo icon that must be white to accept a slide position
const ICON_SPLIT_X = 215;    // reference-frame x where the icon ends and the "OpusClip" lettering begins
const ICON_SLIDE_MAX = 470;  // furthest the icon can be below its resting place, in reference px
const V_TOP_FRACTION = 0.25; // "first letters" = the top quarter of the vertical text
// While the vertical text is up, the logo icon is drawn in stroke by stroke just
// below it (measured: icon top at y=618 in the reference frame, resting place y=254).
const ICON_SLOT_DY = 364;

/* ------------------------------------------------------------------ *
 * Window planning
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Where the 512x512 model window sits in the frame, and how coordinates map.
 *   frame px -> model px:   (p - origin) * k
 *   1080 reference -> model: ref * m
 */
export function planWindow(frameW, frameH) {
  const s = frameW / REFERENCE_WIDTH;
  const span = Math.ceil(ZONE.h * s) + 16;
  const win = Math.min(Math.max(MODEL_SIZE, span), frameW, frameH);
  const k = MODEL_SIZE / win;
  const cx = (ZONE.x + ZONE.w / 2) * s;
  const cy = (ZONE.y + ZONE.h / 2) * s;
  return {
    s, win, k, m: s * k,
    x: clamp(Math.round(cx - win / 2), 0, frameW - win),
    y: clamp(Math.round(cy - win / 2), 0, frameH - win),
    frameW, frameH,
  };
}

/* ------------------------------------------------------------------ *
 * Tiny morphology on Uint8 {0,1} masks (model grid)
 * ------------------------------------------------------------------ */

const N = MODEL_SIZE * MODEL_SIZE;

function step(src, square) {
  const W = MODEL_SIZE;
  const out = new Uint8Array(N);
  for (let y = 0; y < W; y++) {
    const y0 = y > 0 ? y - 1 : 0, y1 = y < W - 1 ? y + 1 : y;
    for (let x = 0; x < W; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x < W - 1 ? x + 1 : x;
      let v = src[y * W + x] | src[y * W + x0] | src[y * W + x1] | src[y0 * W + x] | src[y1 * W + x];
      if (square) v |= src[y0 * W + x0] | src[y0 * W + x1] | src[y1 * W + x0] | src[y1 * W + x1];
      out[y * W + x] = v;
    }
  }
  return out;
}

/** Grow a mask by about `r` px (alternating square and cross steps ~ a disc). */
export function dilate(src, r) {
  let cur = src;
  for (let i = 0; i < r; i++) cur = step(cur, i % 2 === 0);
  return r > 0 ? cur : Uint8Array.from(src);
}

/** Shrink by one pixel (3x3 erosion). */
function erode(src) {
  const W = MODEL_SIZE;
  const out = new Uint8Array(N);
  for (let y = 1; y < W - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      out[i] = src[i] & src[i - 1] & src[i + 1] & src[i - W] & src[i + W]
        & src[i - W - 1] & src[i - W + 1] & src[i + W - 1] & src[i + W + 1];
    }
  }
  return out;
}

const count = (a) => { let n = 0; for (let i = 0; i < a.length; i++) n += a[i]; return n; };

function rectMask(rect, plan) {
  const out = new Uint8Array(N);
  const x0 = clamp(Math.round((rect.x * plan.s - plan.x) * plan.k), 0, MODEL_SIZE);
  const y0 = clamp(Math.round((rect.y * plan.s - plan.y) * plan.k), 0, MODEL_SIZE);
  const x1 = clamp(Math.round(((rect.x + rect.w) * plan.s - plan.x) * plan.k), 0, MODEL_SIZE);
  const y1 = clamp(Math.round(((rect.y + rect.h) * plan.s - plan.y) * plan.k), 0, MODEL_SIZE);
  for (let y = y0; y < y1; y++) out.fill(1, y * MODEL_SIZE + x0, y * MODEL_SIZE + x1);
  return out;
}

/* ------------------------------------------------------------------ *
 * Detector core (pure)
 * ------------------------------------------------------------------ */

/**
 * @param {ReturnType<typeof planWindow>} plan
 * @param {Uint8Array} tH  horizontal silhouette on the model grid (0/1)
 * @param {Uint8Array} tV  vertical silhouette on the model grid (0/1)
 */
export function createDetectorCore(plan, tH, tV) {
  const grow = Math.max(2, Math.round(2.6 * plan.m));    // mask margin around the glyphs
  const slack = Math.max(2, Math.round(2.6 * plan.m));   // zone margin for the intro state

  const maskSettled = dilate(tH, grow);
  const coreH = erode(tH);
  const coreHCount = Math.max(1, count(coreH));

  const ring = (t) => {
    const outer = dilate(t, slack + 5);
    const inner = dilate(t, slack);
    const r = new Uint8Array(N);
    for (let i = 0; i < N; i++) r[i] = outer[i] & (inner[i] ^ 1);
    return r;
  };
  const ringH = ring(tH);
  const ringV = ring(tV);
  const ringHCount = Math.max(1, count(ringH));
  const ringVCount = Math.max(1, count(ringV));

  const strip = rectMask(INTRO_STRIP, plan);
  const stripCount = Math.max(1, count(strip));

  // The only places intro pixels can be: the two exact silhouettes, plus the logo
  // icon while it slides up the strip. Matching shapes (not "any white pixel in a
  // column") is what keeps the game's own white subtitles, which cross that
  // column, from being erased along with the badge.
  const shape = new Uint8Array(N);
  for (let i = 0; i < N; i++) shape[i] = tH[i] | tV[i];

  // icon = the part of the horizontal silhouette left of the lettering
  const splitX = Math.round((ICON_SPLIT_X * plan.s - plan.x) * plan.k);
  const icon = new Uint8Array(N);
  for (let y = 0; y < MODEL_SIZE; y++) {
    for (let x = 0; x < Math.min(splitX, MODEL_SIZE); x++) icon[y * MODEL_SIZE + x] = tH[y * MODEL_SIZE + x];
  }
  const iconCore = erode(icon);
  const iconCorePx = [];
  for (let i = 0; i < N; i++) if (iconCore[i]) iconCorePx.push(i);
  const iconPx = [];
  for (let i = 0; i < N; i++) if (icon[i]) iconPx.push(i);
  const slideMax = Math.round(ICON_SLIDE_MAX * plan.m);

  // top quarter of the vertical text: the reveal starts there
  let vTopRow = MODEL_SIZE, vBottomRow = 0;
  for (let i = 0; i < N; i++) if (tV[i]) { const y = (i / MODEL_SIZE) | 0; if (y < vTopRow) vTopRow = y; if (y > vBottomRow) vBottomRow = y; }
  const vTopLimit = vTopRow + Math.round((vBottomRow - vTopRow) * V_TOP_FRACTION);
  const tVTop = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (tV[i] && ((i / MODEL_SIZE) | 0) <= vTopLimit) tVTop[i] = 1;

  /** Where the icon currently is below its resting place (px on the model grid), or -1. */
  function findIcon(whiteLoose) {
    if (!iconCorePx.length) return -1;
    let best = -1, bestScore = 0;
    for (let dy = 0; dy <= slideMax; dy++) {
      let hit = 0;
      for (let k = 0; k < iconCorePx.length; k++) {
        const p = iconCorePx[k] + dy * MODEL_SIZE;
        if (p >= N) break;
        hit += whiteLoose[p];
      }
      const score = hit / iconCorePx.length;
      if (score > bestScore) { bestScore = score; best = dy; }
    }
    return bestScore >= ICON_SCORE ? best : -1;
  }

  // where the icon sits while it is being drawn in (partially drawn strokes will
  // not match the whole icon, so accept any bright pixel inside this slot)
  const slotDy = Math.round(ICON_SLOT_DY * plan.m);
  const iconSlot = new Uint8Array(N);
  for (let k = 0; k < iconPx.length; k++) {
    const p = iconPx[k] + slotDy * MODEL_SIZE;
    if (p < N) iconSlot[p] = 1;
  }
  const iconSlotZone = dilate(iconSlot, slack);

  const zoneH = dilate(tH, slack);
  const zoneVTop = dilate(tVTop, slack);

  const white = new Uint8Array(N);
  const whiteLoose = new Uint8Array(N);

  let settled = false;
  let hits = 0;
  let animActive = false;

  function reset() { settled = false; hits = 0; animActive = false; }

  /**
   * @param {Uint8ClampedArray} rgba  512x512 RGBA window of the frame
   * @param {{still?:boolean}} [opts] still: a single image, decide immediately
   * @returns {{state:'settled'|'anim'|'none', mask:Uint8Array|null, hScore:number, ringScore:number}}
   */
  function analyze(rgba, opts = {}) {
    let hWhite = 0, hRingWhite = 0, vTopWhite = 0, vRingWhite = 0, stripWhite = 0;
    let hOn = 0, hZoneWhite = 0, vTopZoneWhite = 0;
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
      const m = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const strict = m >= WHITE_SETTLED ? 1 : 0;
      const loose = m >= WHITE_ANIM ? 1 : 0;
      white[i] = strict;
      whiteLoose[i] = loose;
      hWhite += strict & coreH[i];
      hRingWhite += strict & ringH[i];
      vTopWhite += loose & tVTop[i];
      vTopZoneWhite += loose & zoneVTop[i];
      hOn += strict & tH[i];
      hZoneWhite += strict & zoneH[i];
      vRingWhite += loose & ringV[i];
      stripWhite += loose & strip[i];
    }

    const hScore = hWhite / coreHCount;
    const ringScore = hRingWhite / ringHCount;

    if (!settled) {
      if (hScore >= SETTLE_SCORE && ringScore <= RING_LIMIT) {
        hits++;
        if (hits >= (opts.still ? 1 : SETTLE_FRAMES)) settled = true;
      } else {
        hits = 0;
      }
    }
    if (settled) return { state: 'settled', mask: maskSettled, hScore, ringScore };

    // ---- intro animation ----
    const card = stripWhite / stripCount > STRIP_LIMIT;
    const vCard = vRingWhite / ringVCount > RING_LIMIT;
    const hCard = ringScore > RING_LIMIT;
    if (!animActive && !card && !vCard && !hCard
      && ((vTopWhite >= V_EVIDENCE && vTopWhite >= PRECISION * vTopZoneWhite)
        || (hWhite >= H_EVIDENCE && hOn >= PRECISION * hZoneWhite && ringScore <= H_RING_EVIDENCE))) {
      animActive = true;
    }
    if (animActive && !card && !hCard) {
      // text revealed so far (in place, on the two silhouettes) + the sliding icon
      const px = new Uint8Array(N);
      let n = 0;
      for (let i = 0; i < N; i++) { px[i] = whiteLoose[i] & (shape[i] | iconSlotZone[i]); n += px[i]; }
      const dy = findIcon(whiteLoose);
      if (dy >= 0) {
        for (let k = 0; k < iconPx.length; k++) {
          const p = iconPx[k] + dy * MODEL_SIZE;
          if (p < N) { if (!px[p]) n++; px[p] = 1; }
        }
      }
      if (n >= ANIM_MIN_PIXELS) {
        return { state: 'anim', mask: dilate(px, grow), hScore, ringScore };
      }
    }
    return { state: 'none', mask: null, hScore, ringScore };
  }

  /** Raw evidence numbers for the last-frame decision logic, for debugging. */
  function probe(rgba) {
    const saved = { settled, hits, animActive };
    const v = analyze(rgba, { still: true });
    ({ settled, hits, animActive } = saved);
    let vTop = 0, strip_ = 0, ringV_ = 0;
    for (let i = 0; i < N; i++) {
      const j = i * 4;
      const m = Math.min(rgba[j], rgba[j + 1], rgba[j + 2]);
      if (m >= WHITE_ANIM) { vTop += tVTop[i]; strip_ += strip[i]; ringV_ += ringV[i]; }
    }
    return { state: v.state, hScore: v.hScore, ringScore: v.ringScore, vTop, stripFrac: strip_ / stripCount, ringVFrac: ringV_ / ringVCount };
  }

  return { plan, analyze, probe, reset, maskSettled, get settled() { return settled; } };
}

/* ------------------------------------------------------------------ *
 * Browser wrapper: rasterise the PNG silhouettes onto the model grid
 * ------------------------------------------------------------------ */

async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status}).`);
  return createImageBitmap(await res.blob());
}

function raster(bitmap, plan) {
  const c = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#000';
  g.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  g.drawImage(bitmap, -plan.x * plan.k, -plan.y * plan.k, bitmap.width * plan.m, bitmap.height * plan.m);
  const d = g.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = d[i * 4] > 110 ? 1 : 0;
  return out;
}

const bitmapCache = new Map();
function templates() {
  if (!bitmapCache.has('t')) {
    bitmapCache.set('t', Promise.all([loadBitmap(TEMPLATE_H_URL), loadBitmap(TEMPLATE_V_URL)]));
  }
  return bitmapCache.get('t');
}

/** Build a detector for frames of the given size. */
export async function createDetector(frameW, frameH) {
  const plan = planWindow(frameW, frameH);
  const [bh, bv] = await templates();
  return createDetectorCore(plan, raster(bh, plan), raster(bv, plan));
}
