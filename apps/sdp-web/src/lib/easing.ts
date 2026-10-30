/** `x` held to `min..max` (0..1 by default), for the code that does not load three.js. */
export function clamp(x: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, x));
}

/** Ease-out cubic over progress `u`, clamped to 0..1: quick at first, slowing as it lands. */
export function easeOutCubic(u: number): number {
  return 1 - (1 - clamp(u)) ** 3;
}
