/** A dialog's or a step's entrance: short and ease-out, so it never holds up the next action. */
const ENTRANCE_TIMING: KeyframeAnimationOptions = { duration: 150, easing: "ease-out" };

/** The design's mark on something just made: held for 55% of 1.4s, then eased away. */
const MARK_DURATION_MS = 1400;
const MARK_HOLD = 0.55;
const MARK_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Whether `element` animates: not under reduced motion, nor without the Web Animations API. */
function animates(element: HTMLElement): boolean {
  // The DOM types promise `animate`, but jsdom does not implement it.
  if (typeof element.animate !== "function") {
    return false;
  }
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Plays an entrance on `element`, from the first keyframe to the last. It leaves no style
 * behind once it ends, so a scale never lingers as a transform that would re-anchor the
 * fixed-position popups a dialog hosts. Skipped when the viewer asks for reduced motion, and
 * where there is no Web Animations API to run it (jsdom).
 *
 * @param element - The element that enters.
 * @param keyframes - Where the entrance starts and ends, in compositor-only properties.
 *
 * @example
 * ```ts
 * playEntrance(panel, [{ transform: "scale(0.97)" }, { transform: "none" }]);
 * ```
 */
export function playEntrance(element: HTMLElement, keyframes: Keyframe[]): void {
  if (animates(element)) {
    element.animate(keyframes, ENTRANCE_TIMING);
  }
}

/**
 * Marks `element` as just made, as the design marks a new link or record: its background takes
 * the tile's paper, holds it for a little over half the mark, then clears. Like an entrance it
 * leaves no style behind, and it is skipped under reduced motion and without the Web Animations
 * API (jsdom).
 *
 * @param element - The element to mark; it has no background of its own to return to.
 *
 * @example
 * ```ts
 * playMark(link);
 * ```
 */
export function playMark(element: HTMLElement): void {
  if (!animates(element)) {
    return;
  }
  const held = { backgroundColor: "var(--surface-tile)" };
  element.animate(
    [
      { ...held, offset: 0 },
      { ...held, offset: MARK_HOLD, easing: MARK_EASING },
      { backgroundColor: "transparent" },
    ],
    MARK_DURATION_MS
  );
}
