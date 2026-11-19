/**
 * OpusClip badge & animated intro geometry.
 *
 * Measured across consensus frames of independent exports:
 *   settled horizontal badge: x=124 y=254 w=353 h=84
 *   animated vertical badge:   x=124 y=272 w=82  h=377  ("Created with" + P mark)
 *
 * Animation timeline:
 *   t < 4.75s:          NO watermark (clean video)
 *   4.75s <= t < 7.10s: VERTICAL watermark only
 *   7.10s <= t < 7.90s: Morph / rotation into horizontal position
 *   t >= 7.90s:         HORIZONTAL watermark only
 */

export const REFERENCE_WIDTH = 1080;

export const BADGE_HORIZONTAL = { x: 124, y: 254, w: 353, h: 84 };
export const BADGE_VERTICAL   = { x: 124, y: 272, w: 82,  h: 377 };

// Legacy aliases
export const BADGE = { x: 124, y: 254, w: 353, h: 84 };
export const INTRO = { x: 124, y: 272, w: 82,  h: 377 };

export const WATERMARK_START       = 4.75;
export const WATERMARK_MORPH_START = 7.10;
export const WATERMARK_SETTLE      = 7.90;
export const INTRO_END_SECONDS     = 7.90;

export function scaleRect(rect, frameWidth) {
  if (!rect) return null;
  const s = frameWidth / REFERENCE_WIDTH;
  return {
    x: Math.round(rect.x * s),
    y: Math.round(rect.y * s),
    w: Math.max(1, Math.round(rect.w * s)),
    h: Math.max(1, Math.round(rect.h * s)),
  };
}

export function badgeRect(frameWidth) {
  return scaleRect(BADGE_HORIZONTAL, frameWidth);
}

export function verticalBadgeRect(frameWidth) {
  return scaleRect(BADGE_VERTICAL, frameWidth);
}

export function introRect(frameWidth, timeSeconds = 0) {
  if (timeSeconds >= WATERMARK_SETTLE) return null;
  return scaleRect(BADGE_VERTICAL, frameWidth);
}

export function watermarkRect(frameWidth, timeSeconds = 999) {
  if (timeSeconds < WATERMARK_START) {
    return null;
  }
  if (timeSeconds < WATERMARK_MORPH_START) {
    return scaleRect(BADGE_VERTICAL, frameWidth);
  }
  if (timeSeconds < WATERMARK_SETTLE) {
    const p = (timeSeconds - WATERMARK_MORPH_START) / (WATERMARK_SETTLE - WATERMARK_MORPH_START);
    const rect = {
      x: 124,
      y: Math.round(272 - 18 * p),
      w: Math.round(82 + 271 * p),
      h: Math.round(377 - 293 * p),
    };
    return scaleRect(rect, frameWidth);
  }
  return scaleRect(BADGE_HORIZONTAL, frameWidth);
}

export function drawMask(ctx, width, height, opts = {}) {
  const { time = 999, pad = 5, mode = 'auto' } = opts;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#fff';

  let rect = null;
  if (mode === 'horizontal') {
    rect = badgeRect(width);
  } else if (mode === 'vertical') {
    rect = verticalBadgeRect(width);
  } else if (opts.includeIntro === false) {
    rect = badgeRect(width);
  } else if (opts.includeIntro === true) {
    rect = verticalBadgeRect(width) || badgeRect(width);
  } else {
    rect = watermarkRect(width, time);
  }

  if (rect) {
    ctx.fillRect(
      Math.max(0, rect.x - pad),
      Math.max(0, rect.y - pad),
      Math.min(width - (rect.x - pad), rect.w + pad * 2),
      Math.min(height - (rect.y - pad), rect.h + pad * 2)
    );
  }
}

export function badgeCoverage(rgba, width, height, time = 999) {
  const rect = (time >= WATERMARK_START && time < WATERMARK_MORPH_START)
    ? verticalBadgeRect(width)
    : badgeRect(width);

  if (!rect) return 0;
  let hit = 0;
  let total = 0;
  for (let y = rect.y; y < Math.min(rect.y + rect.h, height); y++) {
    for (let x = rect.x; x < Math.min(rect.x + rect.w, width); x++) {
      const i = (y * width + x) * 4;
      const r0 = rgba[i], g0 = rgba[i + 1], b0 = rgba[i + 2];
      const max = Math.max(r0, g0, b0);
      const min = Math.min(r0, g0, b0);
      if (max > 220 && max - min < 50) hit++;
      total++;
    }
  }
  return total ? hit / total : 0;
}
