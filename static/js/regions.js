/**
 * User-drawn removal areas ("extra areas"): rectangles the user marks on the
 * preview, stored as fractions of the frame (0..1) so the same areas apply to
 * every file in a batch whatever its resolution.
 *
 * Each area gets its own model window: a square at least 512 px wide (so small
 * areas are inpainted at full resolution), centred on the area, with context
 * around it. Larger areas get a larger window that is scaled down to 512.
 * Pure — tested in Node.
 */

export const MODEL_SIZE = 512;
const PAD = 32;    // frame px of context kept on each side of an area, at least

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Fractional rect -> frame px rect, clamped to the frame. Null when degenerate. */
export function toPixels(r, frameW, frameH) {
  const x0 = clamp(Math.round(r.x * frameW), 0, frameW);
  const y0 = clamp(Math.round(r.y * frameH), 0, frameH);
  const x1 = clamp(Math.round((r.x + r.w) * frameW), 0, frameW);
  const y1 = clamp(Math.round((r.y + r.h) * frameH), 0, frameH);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Model window and mask for one area.
 * @returns {{x:number,y:number,win:number,k:number,m:number,mask:Uint8Array}|null}
 */
export function planArea(r, frameW, frameH, grow = 3) {
  const px = toPixels(r, frameW, frameH);
  if (!px) return null;
  const side = Math.max(px.w, px.h) + 2 * PAD;
  const win = Math.min(Math.max(MODEL_SIZE, side), frameW, frameH);
  const cx = px.x + px.w / 2, cy = px.y + px.h / 2;
  const x = clamp(Math.round(cx - win / 2), 0, frameW - win);
  const y = clamp(Math.round(cy - win / 2), 0, frameH - win);
  const k = MODEL_SIZE / win;

  // Area -> model grid, grown a little so anti-aliased edges are covered too.
  const mx0 = clamp(Math.floor((px.x - x) * k) - grow, 0, MODEL_SIZE);
  const my0 = clamp(Math.floor((px.y - y) * k) - grow, 0, MODEL_SIZE);
  const mx1 = clamp(Math.ceil((px.x + px.w - x) * k) + grow, 0, MODEL_SIZE);
  const my1 = clamp(Math.ceil((px.y + px.h - y) * k) + grow, 0, MODEL_SIZE);
  const mask = new Uint8Array(MODEL_SIZE * MODEL_SIZE);
  for (let yy = my0; yy < my1; yy++) mask.fill(1, yy * MODEL_SIZE + mx0, yy * MODEL_SIZE + mx1);
  return { x, y, win, k, m: k, mask };
}
