/** Easing curves shared by the homepage scenes. */

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Decelerating; clamped, so a time past the end holds at 1. */
export const easeOutCubic = (x: number) => 1 - (1 - clamp01(x)) ** 3;

/** Slow in and out; clamped. */
export const easeInOutCubic = (x: number) => {
  const u = clamp01(x);
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
};

/** Slow in and out, gentler than cubic; expects 0..1 and is left unclamped. */
export const easeInOutQuad = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
