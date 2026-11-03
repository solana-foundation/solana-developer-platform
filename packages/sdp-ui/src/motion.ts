/** A dialog's or a step's entrance: short and ease-out, so it never holds up the next action. */
const ENTRANCE_TIMING: KeyframeAnimationOptions = { duration: 150, easing: "ease-out" };

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
  // The DOM types promise `animate`, but jsdom does not implement it.
  if (typeof element.animate !== "function") {
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  element.animate(keyframes, ENTRANCE_TIMING);
}
