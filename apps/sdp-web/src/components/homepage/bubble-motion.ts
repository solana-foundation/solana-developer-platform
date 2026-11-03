/*
 * The motion the page's live bubbles (a pill in two rings) share: the light that follows the
 * pointer (payments).
 */

/**
 * A live bubble (bubble.module.css `.live`) answers the pointer: the light in its pill follows it
 * (--mx and --my on the bubble, from the pill's box). Hover devices only. Returns the stop function.
 */
export function followPointer(root: HTMLElement, pill: HTMLElement) {
  if (!window.matchMedia?.("(hover: hover)").matches) return () => {};
  const move = (event: PointerEvent) => {
    const box = pill.getBoundingClientRect();
    root.style.setProperty(
      "--mx",
      `${(((event.clientX - box.left) / box.width) * 100).toFixed(1)}%`
    );
    root.style.setProperty(
      "--my",
      `${(((event.clientY - box.top) / box.height) * 100).toFixed(1)}%`
    );
  };
  root.addEventListener("pointermove", move, { passive: true });
  return () => root.removeEventListener("pointermove", move);
}

/** The pill fits its word: the word as it stands plus the room either side of it (--pxx). */
export function fitPill(pill: HTMLElement, word: HTMLElement | null | undefined) {
  if (word) pill.style.width = `calc(${word.offsetWidth.toFixed(1)}px + var(--pxx))`;
}
