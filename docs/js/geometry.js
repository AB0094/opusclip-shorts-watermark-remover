/**
 * OpusClip badge geometry.
 *
 * The OpusClip watermark is not placed by a model — it is a fixed overlay,
 * composited by OpusClip's renderer at a fixed anchor. Measured from real
 * 1080x1920 exports:
 *
 *   settled badge   x=123 y=254 w=355 h=85
 *   intro animation x=124 y=254 w=86  h=456   ("Created with" + P mark, vertical)
 *
 * The intro state is the same logo rotated 90° and parked at the same corner;
 * it plays for roughly the first 8 seconds, then settles into the horizontal
 * badge. Both states share the top-left anchor, so one scaled mask covers every
 * export we have measured.
 *
 * All coordinates are in a 1080x1920 reference frame and scale linearly with
 * frame width. (Width, not height, because the badge anchor is horizontal.)
 */

export const REFERENCE_WIDTH = 1080;

export const BADGE = { x: 123, y: 254, w: 355, h: 85 };
export const INTRO = { x: 124, y: 254, w: 86, h: 456 };

/** Seconds the intro animation is assumed to run. Measured 7.65-8.0s. */
export const INTRO_END_SECONDS = 8.5;

/**
 * Scale a reference-frame rect to a real frame.
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {number} frameWidth
 */
export function scaleRect(rect, frameWidth) {
  const s = frameWidth / REFERENCE_WIDTH;
  return {
    x: Math.round(rect.x * s),
    y: Math.round(rect.y * s),
    w: Math.max(1, Math.round(rect.w * s)),
    h: Math.max(1, Math.round(rect.h * s)),
  };
}

/**
 * The badge rectangle for a given frame size. Unlike the intro, this is on
 * screen for the whole clip, so it is always masked.
 */
export function badgeRect(frameWidth) {
  return scaleRect(BADGE, frameWidth);
}

/**
 * The intro rectangle, or null when the clip is past the intro.
 * @param {number} frameWidth
 * @param {number} timeSeconds
 */
export function introRect(frameWidth, timeSeconds) {
  if (timeSeconds >= INTRO_END_SECONDS) return null;
  return scaleRect(INTRO, frameWidth);
}

/**
 * Draw the removal mask for one frame into a 2D context.
 *
 * We deliberately use solid rectangles rather than tracing the glyph outlines:
 * the overlay is opaque, so anything inside its bounding box is unrecoverable
 * anyway, and a rectangle guarantees no anti-aliased fringe survives. The mask
 * is drawn white on transparent; the inpainter reads alpha.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{time?:number, includeIntro?:boolean, pad?:number}} opts
 */
export function drawMask(ctx, width, height, opts = {}) {
  // The pad is deliberate: the patch that gets composited back is feathered at
  // its border, and the ramp must fall entirely outside the glyph box so no
  // anti-aliased watermark edge survives.
  const { time = 0, includeIntro = true, pad = 5 } = opts;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#fff';

  const rects = [badgeRect(width)];
  if (includeIntro) {
    const intro = introRect(width, time);
    if (intro) rects.push(intro);
  }

  for (const r of rects) {
    ctx.fillRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
  }
}

/**
 * How much of the badge box is actually covered by near-white pixels.
 *
 * Used to sanity-check that a clip really carries the OpusClip badge before we
 * spend a minute inpainting a region that has nothing in it. Not a detector in
 * the general sense — the position is known, this only confirms presence.
 *
 * @param {Uint8ClampedArray} rgba  full-frame RGBA
 * @param {number} width
 * @param {number} height
 * @param {number} time
 * @returns {number} 0..1 coverage of the badge box
 */
export function badgeCoverage(rgba, width, height, time = 999) {
  const rects = [badgeRect(width)];
  const intro = introRect(width, time);
  if (intro) rects.push(intro);

  let hit = 0;
  let total = 0;
  for (const r of rects) {
    for (let y = r.y; y < Math.min(r.y + r.h, height); y++) {
      for (let x = r.x; x < Math.min(r.x + r.w, width); x++) {
        const i = (y * width + x) * 4;
        const r0 = rgba[i], g0 = rgba[i + 1], b0 = rgba[i + 2];
        // near-white: bright and desaturated
        const max = Math.max(r0, g0, b0);
        const min = Math.min(r0, g0, b0);
        if (max > 225 && max - min < 45) hit++;
        total++;
      }
    }
  }
  return total ? hit / total : 0;
}
