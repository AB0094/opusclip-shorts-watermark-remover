/**
 * OpusClip badge geometry, in the 1080-wide reference frame.
 *
 * The badge is composited by OpusClip's renderer, so it is pixel-identical in
 * every export. Two exact silhouettes were measured by pixel consensus across
 * several exports and ship as PNGs (white = badge, 550x650, origin at the
 * frame's top-left corner):
 *
 *   assets/wm-horizontal.png   settled badge:  logo + "OpusClip"
 *   assets/wm-vertical.png     intro state:    vertical "Created with" text
 *
 * The badge goes through three states: an animated intro (vertical text, then
 * the logo sliding up while "OpusClip" types in) and then the settled
 * horizontal badge, which stays to the end of the clip. WHEN that happens
 * differs between clips (one trimmed sample has it from t=0), so nothing here is
 * keyed to time: states are recognised from the pixels (see watermark.js).
 */

export const REFERENCE_WIDTH = 1080;

export const TEMPLATE_H_URL = 'assets/wm-horizontal.png';
export const TEMPLATE_V_URL = 'assets/wm-vertical.png';

/** Settled badge bounding box. */
export const BADGE_HORIZONTAL = { x: 124, y: 254, w: 353, h: 84 };

/**
 * Column the intro state lives in: the vertical text, and the logo as it slides
 * up along it. Reaches below the 650 px the vertical template was cropped to,
 * because the logo sits underneath the text.
 */
export const INTRO_STRIP = { x: 112, y: 240, w: 104, h: 474 };

/** Union of every place the badge can be: the window we inpaint is centred on it. */
export const ZONE = { x: 112, y: 240, w: 378, h: 474 };

/** Aliases kept for readability elsewhere. */
export const BADGE = BADGE_HORIZONTAL;

export function scaleRect(rect, frameWidth) {
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
