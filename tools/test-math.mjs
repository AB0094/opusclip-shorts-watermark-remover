/**
 * Pure regression tests. No browser, no canvas, no model.
 *
 * The things most likely to break silently:
 *   - mask polarity (MI-GAN: 1 = keep. LaMa: 1 = hole). A flip inpaints
 *     everything except the badge and never throws.
 *   - output range mapping (MI-GAN [-1,1], LaMa already 0..255).
 *   - the detector state machine: a white caption card must not be mistaken for
 *     the badge, and the settled state must be sticky.
 *
 * Run: node tools/test-math.mjs
 */

import assert from 'node:assert/strict';
import {
  buildMIGANInput, buildLamaInputs, chwToRGBA, buildOverlay, temporalMedian, patchMotion, SIZE,
} from '../static/js/inpainter.js';
import { planWindow, createDetectorCore, dilate, MODEL_SIZE } from '../static/js/watermark.js';
import { badgeRect, scaleRect, BADGE_HORIZONTAL, ZONE } from '../static/js/geometry.js';

let pass = 0;
const test = (name, fn) => {
  fn();
  pass++;
  console.log(`  ok  ${name}`);
};

const N = SIZE * SIZE;

/* ------------------------------------------------------------------ */
console.log('\ngeometry');

test('badge geometry is the measured one at 1080x1920', () => {
  assert.deepEqual(badgeRect(1080), { x: 124, y: 254, w: 353, h: 84 });
});

test('badge scales with width', () => {
  assert.deepEqual(badgeRect(720), { x: 83, y: 169, w: 235, h: 56 });
});

test('scaleRect keeps a minimum size of 1', () => {
  const r = scaleRect({ x: 0, y: 0, w: 1, h: 1 }, 10);
  assert.ok(r.w >= 1 && r.h >= 1);
});

console.log('\nwindow plan');

test('1080 wide: native 512 window that contains the whole badge zone', () => {
  const p = planWindow(1080, 1920);
  assert.equal(p.win, 512);
  assert.equal(p.k, 1);
  assert.ok(p.x <= ZONE.x && p.x + p.win >= ZONE.x + ZONE.w, 'zone not inside window horizontally');
  assert.ok(p.y <= ZONE.y && p.y + p.win >= ZONE.y + ZONE.h, 'zone not inside window vertically');
});

test('720 wide: still a native 512 window, zone still inside', () => {
  const p = planWindow(720, 1280);
  assert.equal(p.win, 512);
  const zx = ZONE.x * p.s, zy = ZONE.y * p.s;
  assert.ok(p.x <= zx && p.y <= zy);
  assert.ok(p.x + p.win >= (ZONE.x + ZONE.w) * p.s && p.y + p.win >= (ZONE.y + ZONE.h) * p.s);
});

test('2160 wide: window grows and is resampled to 512', () => {
  const p = planWindow(2160, 3840);
  assert.ok(p.win > 512);
  assert.ok(Math.abs(p.k - 512 / p.win) < 1e-9);
  assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.win <= 2160 && p.y + p.win <= 3840);
});

test('window never leaves a small frame', () => {
  const p = planWindow(360, 640);
  assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.win <= 360 && p.y + p.win <= 640);
});

/* ------------------------------------------------------------------ */
console.log('\ntensor math');

/** 2x2 window where only the first pixel is masked. */
function fixture() {
  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255,      // red   (masked)
    0, 255, 0, 255,      // green
    0, 0, 255, 255,      // blue
    128, 128, 128, 255,  // grey
  ]);
  const mask = new Uint8Array([1, 0, 0, 0]);
  return { rgba, mask };
}

test('MI-GAN input: 4 planes; masked pixel = -0.5 with zeroed colour', () => {
  const { rgba, mask } = fixture();
  const out = buildMIGANInput(rgba, mask);
  assert.equal(out.length, 16);
  assert.equal(out[0], -0.5);
  assert.equal(Math.abs(out[4]), 0);
  assert.equal(Math.abs(out[8]), 0);
  assert.equal(Math.abs(out[12]), 0);
});

test('MI-GAN input: kept pixel = +0.5 with colour in [-1,1]', () => {
  const { rgba, mask } = fixture();
  const out = buildMIGANInput(rgba, mask);
  assert.equal(out[1], 0.5);
  assert.equal(out[1 + 4], -1);
  assert.equal(out[1 + 8], 1);
  assert.equal(out[1 + 12], -1);
});

test('LaMa input: image in [0,1], hole mask is 1 where removed (opposite of MI-GAN)', () => {
  const { rgba, mask } = fixture();
  const { image, holes } = buildLamaInputs(rgba, mask);
  assert.equal(image.length, 12);
  assert.equal(image[0], 1);          // red pixel, R
  assert.equal(image[4 + 1], 1);      // green pixel, G plane
  assert.deepEqual(Array.from(holes), [1, 0, 0, 0]);
});

test('MI-GAN output maps [-1,1] to [0,255] and clamps', () => {
  const rgba = chwToRGBA(new Float32Array([-1, 0, 1]), 127.5, 127.5);
  assert.deepEqual(Array.from(rgba), [0, 128, 255, 255]);
  const clamped = chwToRGBA(new Float32Array([-5, 5, 0]), 127.5, 127.5);
  assert.deepEqual(Array.from(clamped), [0, 255, 128, 255]);
});

test('LaMa output is already 0..255 and is not rescaled', () => {
  const rgba = chwToRGBA(new Float32Array([10, 200, 300]), 1, 0);
  assert.deepEqual(Array.from(rgba), [10, 200, 255, 255]);
});

/* ------------------------------------------------------------------ */
console.log('\ncompositing');

test('overlay is opaque inside the mask, fades 1 px outside, transparent far away', () => {
  const filled = new Uint8ClampedArray(N * 4).fill(200);
  const mask = new Uint8Array(N);
  for (let y = 100; y < 110; y++) for (let x = 100; x < 110; x++) mask[y * SIZE + x] = 1;
  const o = buildOverlay(filled, mask);
  const a = (x, y) => o[(y * SIZE + x) * 4 + 3];
  assert.equal(a(105, 105), 255);
  assert.ok(a(99, 105) > 0 && a(99, 105) < 255, 'edge pixel should be partly transparent');
  assert.equal(a(90, 105), 0);
  assert.equal(o[(105 * SIZE + 105) * 4], 200);
});

test('temporal median takes the middle value inside the mask only', () => {
  const mk = (v) => new Uint8ClampedArray(N * 4).fill(v);
  const mask = new Uint8Array(N);
  mask[5] = 1;
  const out = temporalMedian([mk(10), mk(200), mk(60)], mask);
  assert.equal(out[5 * 4], 60);
  assert.equal(out[6 * 4], 60);       // outside the mask: newest frame untouched
  const spike = temporalMedian([mk(50), mk(250), mk(52)], mask);
  assert.equal(spike[5 * 4], 52);     // a one-frame spike is rejected
});

test('patchMotion is 0 for identical fills and large for different ones', () => {
  const mask = new Uint8Array(N).fill(1);
  const a = new Uint8ClampedArray(N * 4).fill(10);
  const b = new Uint8ClampedArray(N * 4).fill(110);
  assert.equal(patchMotion(a, a, mask), 0);
  assert.ok(patchMotion(a, b, mask) >= 100);
});

/* ------------------------------------------------------------------ */
console.log('\ndetector');

const plan = planWindow(1080, 1920);
const WIN = MODEL_SIZE;

function blockMask(x0, y0, x1, y1) {
  const m = new Uint8Array(N);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * WIN + x] = 1;
  return m;
}
// stand-ins for the two silhouettes: a wide block (settled badge) and a tall thin bar (intro text)
const tH = blockMask(80, 20, 380, 100);
const tV = blockMask(90, 40, 100, 330);

function frame(fillFn) {
  const f = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const [r, g, b] = fillFn(i % WIN, (i / WIN) | 0);
    f[i * 4] = r; f[i * 4 + 1] = g; f[i * 4 + 2] = b; f[i * 4 + 3] = 255;
  }
  return f;
}
const grey = (v) => () => [v, v, v];
const withWhite = (mask, bg = 90) => frame((x, y) => (mask[y * WIN + x] ? [255, 255, 255] : [bg, bg - 10, bg - 20]));

test('dilate grows a single pixel into a blob of about the requested radius', () => {
  const m = new Uint8Array(N);
  m[200 * WIN + 200] = 1;
  const d = dilate(m, 3);
  let n = 0; for (let i = 0; i < N; i++) n += d[i];
  assert.ok(n >= 25 && n <= 49, `unexpected area ${n}`);
  assert.equal(d[200 * WIN + 203], 1);
  assert.equal(d[200 * WIN + 205], 0);
});

test('plain picture: nothing to remove, frame passes through', () => {
  const det = createDetectorCore(plan, tH, tV);
  assert.equal(det.analyze(frame(grey(90))).state, 'none');
  assert.equal(det.analyze(frame(grey(90))).mask, null);
});

test('settled badge: needs two consecutive frames, then returns the grown silhouette', () => {
  const det = createDetectorCore(plan, tH, tV);
  const f = withWhite(tH);
  // the first frame is already cleaned (as animation) while the second confirms it
  const first = det.analyze(f);
  assert.equal(first.state, 'anim');
  assert.ok(first.mask, 'first frame must not be left untouched');
  const v = det.analyze(f);
  assert.equal(v.state, 'settled');
  assert.equal(v.mask[50 * WIN + 200], 1, 'silhouette interior must be masked');
  assert.equal(v.mask[18 * WIN + 200], 1, 'mask must extend a little past the glyphs');
  assert.equal(v.mask[2 * WIN + 200], 0, 'far from the badge must stay untouched');
});

test('a still image settles immediately', () => {
  const det = createDetectorCore(plan, tH, tV);
  assert.equal(det.analyze(withWhite(tH), { still: true }).state, 'settled');
});

test('settled state is sticky even if a later frame is dark under the badge', () => {
  const det = createDetectorCore(plan, tH, tV);
  det.analyze(withWhite(tH)); det.analyze(withWhite(tH));
  assert.equal(det.analyze(frame(grey(20))).state, 'settled');
});

test('a big white caption card is not the badge', () => {
  const det = createDetectorCore(plan, tH, tV);
  const card = frame(() => [255, 255, 255]);
  for (let i = 0; i < 5; i++) assert.equal(det.analyze(card).state, 'none');
  assert.equal(det.settled, false);
});

test('intro text over a normal picture is masked as animation, then settles', () => {
  const det = createDetectorCore(plan, tH, tV);
  const intro = det.analyze(withWhite(tV));
  assert.equal(intro.state, 'anim');
  assert.equal(intro.mask[100 * WIN + 95], 1);
  assert.equal(intro.mask[100 * WIN + 300], 0);
  det.analyze(withWhite(tH));
  assert.equal(det.analyze(withWhite(tH)).state, 'settled');
});

test('white game subtitles crossing the intro column are left alone during the intro', () => {
  const det = createDetectorCore(plan, tH, tV);
  const subtitle = blockMask(110, 300, 175, 320);   // inside the intro column, on no silhouette
  const both = new Uint8Array(N);
  for (let i = 0; i < N; i++) both[i] = tV[i] | subtitle[i];
  const v = det.analyze(withWhite(both));
  assert.equal(v.state, 'anim');
  assert.equal(v.mask[100 * WIN + 95], 1, 'intro text must still be masked');
  assert.equal(v.mask[310 * WIN + 140], 0, 'subtitle pixels must NOT be masked');
});

test('a half-drawn logo icon in its starting slot is masked, even though it is not a full icon', () => {
  const det = createDetectorCore(plan, tH, tV);
  // the slot is the icon silhouette 364 px below its resting place; light up only a few strokes of it
  const strokes = blockMask(100, 20 + 364 + 10, 108, 20 + 364 + 60);
  const both = new Uint8Array(N);
  for (let i = 0; i < N; i++) both[i] = tV[i] | strokes[i];
  const v = det.analyze(withWhite(both));
  assert.equal(v.state, 'anim');
  assert.equal(v.mask[(20 + 364 + 30) * WIN + 104], 1, 'drawn-in stroke must be masked');
});

test('the logo icon is found and masked while it slides up the column', () => {
  const det = createDetectorCore(plan, tH, tV);
  // icon silhouette = left part of tH; slide it 200 px down and light it up, plus the first intro letters
  const slid = new Uint8Array(N);
  for (let y = 20; y < 100; y++) for (let x = 80; x < 171; x++) slid[(y + 200) * WIN + x] = 1;
  const both = new Uint8Array(N);
  for (let i = 0; i < N; i++) both[i] = slid[i] | tV[i];
  const v = det.analyze(withWhite(both));
  assert.equal(v.state, 'anim');
  assert.equal(v.mask[260 * WIN + 120], 1, 'slid icon must be masked');
  assert.equal(v.mask[380 * WIN + 120], 0, 'nothing below the icon');
});

test('a caption card that merely overlaps the intro text area does not start the intro', () => {
  // thin-stroke silhouettes, like real lettering (3 px strokes, 4 px gaps)
  const strokes = (x0, y0, x1, y1) => {
    const m = new Uint8Array(N);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if ((x - x0) % 7 < 3) m[y * WIN + x] = 1;
    return m;
  };
  const sH = strokes(80, 20, 380, 100);
  const sV = strokes(90, 40, 130, 330);
  const det = createDetectorCore(plan, sH, sV);
  const card = blockMask(60, 30, 250, 130);   // solid white over part of both areas
  for (let i = 0; i < 4; i++) {
    const v = det.analyze(withWhite(card));
    assert.equal(v.state, 'none', 'card must not be treated as the badge');
    assert.equal(v.mask, null);
  }
  // while the real strokes, drawn on their own, are recognised
  const real = createDetectorCore(plan, sH, sV);
  assert.equal(real.analyze(withWhite(sV)).state, 'anim');
});

test('a few stray white pixels before the badge exists do not trigger anything', () => {
  const det = createDetectorCore(plan, tH, tV);
  const stray = blockMask(300, 400, 304, 404);   // outside every template and the intro strip
  assert.equal(det.analyze(withWhite(stray)).state, 'none');
});

test('reset() forgets the settled state', () => {
  const det = createDetectorCore(plan, tH, tV);
  det.analyze(withWhite(tH)); det.analyze(withWhite(tH));
  det.reset();
  assert.equal(det.analyze(frame(grey(20))).state, 'none');
});

console.log(`\n${pass} tests passed\n`);
