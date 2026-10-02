/**
 * Paints now, then again at most once per animation frame while the page
 * scrolls and, unless told otherwise, resizes. Returns the function that stops
 * listening and drops any frame still pending.
 */
export function onScrollFrame(paint: () => void, { resize = true } = {}): () => void {
  let frame = 0;
  const onChange = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
  };
  paint();
  window.addEventListener("scroll", onChange, { passive: true });
  if (resize) window.addEventListener("resize", onChange);
  return () => {
    window.removeEventListener("scroll", onChange);
    if (resize) window.removeEventListener("resize", onChange);
    cancelAnimationFrame(frame);
  };
}
