/**
 * Pure-math regression tests. No browser, no canvas, no model.
 *
 * The two things most likely to break silently:
 *   - mask polarity (MI-GAN wants 1=keep, 0=inpaint — the inverse of LaMa)
 *   - output range mapping ([-1,1] -> [0,255], not [0,1] -> [255])
 * Both fail as "watermark still visible" or "everything is washed out",
 * never as an exception, which is why they are tested.
 *
 * Run: node tools/test-math.mjs
 */

import assert from 'node:assert/strict';
import {
  buildMIGANInput,
  miganOutputToRGBA,
  findMaskBbox,
} from '../static/js/inpainter.js';
import { badgeRect, introRect, scaleRect, BADGE, INTRO, INTRO_END_SECONDS } from '../static/js/geometry.js';

let pass = 0;
const test = (name, fn) => {
  fn();
  pass++;
  console.log(`  ok  ${name}`);
};

console.log('\ngeometry');

test('badge geometry is the measured one at 1080x1920', () => {
  assert.deepEqual(badgeRect(1080), { x: 124, y: 254, w: 353, h: 84 });
});

test('badge scales with width', () => {
  assert.deepEqual(badgeRect(720), { x: 83, y: 169, w: 235, h: 56 });
  assert.deepEqual(badgeRect(540), { x: 62, y: 127, w: 177, h: 42 });
});

test('badge stays in frame at every common width', () => {
  for (const w of [360, 540, 720, 1080, 1440]) {
    const r = badgeRect(w);
    const h = Math.round(w * 16 / 9);
    assert.ok(r.x >= 0 && r.y >= 0, `negative origin at ${w}`);
    assert.ok(r.x + r.w < w, `badge runs off the right edge at ${w}`);
    assert.ok(r.y + r.h < h, `badge runs off the bottom at ${w}`);
  }
});

test('intro state only exists before the settle time', () => {
  assert.ok(introRect(1080, 0));
  assert.ok(introRect(1080, INTRO_END_SECONDS - 0.1));
  assert.equal(introRect(1080, INTRO_END_SECONDS), null);
});

test('intro is taller than the settled badge', () => {
  const i = scaleRect(INTRO, 1080);
  assert.ok(i.h > BADGE.h * 4);
  assert.equal(i.x, INTRO.x);
});

console.log('\ntensor math');

/** 2x2 RGBA image where only the top-left pixel is masked. */
function fixture() {
  const image = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      255, 0, 0, 255,      // red   (masked)
      0, 255, 0, 255,      // green
      0, 0, 255, 255,      // blue
      128, 128, 128, 255,  // grey
    ]),
  };
  const mask = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      255, 255, 255, 255,  // masked
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]),
  };
  return { image, mask };
}

test('input has 4 planes of w*h floats', () => {
  const { image, mask } = fixture();
  const out = buildMIGANInput(image, mask);
  assert.equal(out.length, 4 * 4);
});

test('masked pixel: plane0 = -0.5 and colour planes are zeroed', () => {
  const { image, mask } = fixture();
  const out = buildMIGANInput(image, mask);
  assert.equal(out[0], -0.5);
  assert.equal(Math.abs(out[4]), 0);
  assert.equal(Math.abs(out[8]), 0);
  assert.equal(Math.abs(out[12]), 0);
});

test('kept pixel: plane0 = +0.5 and colour is normalised to [-1,1]', () => {
  const { image, mask } = fixture();
  const out = buildMIGANInput(image, mask);
  const i = 1;                 // green pixel
  assert.equal(out[i], 0.5);
  assert.equal(out[i + 4], -1);   // R = 0
  assert.equal(out[i + 8], 1);    // G = 255
  assert.equal(out[i + 12], -1);  // B = 0
});

test('polarity is inverted relative to LaMa', () => {
  // If this ever flips, the model inpaints the whole frame except the badge.
  const { image, mask } = fixture();
  const out = buildMIGANInput(image, mask);
  assert.ok(out[0] < 0, 'masked pixel should be negative in plane 0');
  assert.ok(out[1] > 0, 'unmasked pixel should be positive in plane 0');
});

test('output maps [-1,1] to [0,255]', () => {
  // 1 pixel, 3 channels: R=-1, G=0, B=1
  const rgba = miganOutputToRGBA(new Float32Array([-1, 0, 1]), 1, 1);
  assert.equal(rgba[0], 0);
  assert.equal(rgba[1], 128);
  assert.equal(rgba[2], 255);
  assert.equal(rgba[3], 255);   // alpha is always opaque
});

test('output clamps out-of-range values instead of wrapping', () => {
  const rgba = miganOutputToRGBA(new Float32Array([-5, 5, 0]), 1, 1);
  assert.equal(rgba[0], 0);
  assert.equal(rgba[1], 255);
  assert.equal(rgba[2], 128);
});

console.log('\nmask bbox');

test('bbox hugs the masked pixels', () => {
  const mask = {
    width: 4, height: 4,
    data: new Uint8ClampedArray(4 * 4 * 4),
  };
  const set = (x, y) => { mask.data[(y * 4 + x) * 4 + 3] = 255; };
  set(1, 1); set(2, 2);
  assert.deepEqual(findMaskBbox(mask), { x: 1, y: 1, w: 2, h: 2 });
});

test('empty mask returns null', () => {
  const mask = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  assert.equal(findMaskBbox(mask), null);
});

console.log(`\n${pass} tests passed\n`);
