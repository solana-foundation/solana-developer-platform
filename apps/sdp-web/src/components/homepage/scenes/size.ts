/**
 * Follows the box a scene draws in. Each call re-reads `host`'s size and the
 * pixel density (capped at 2) and, only when one of them changed, calls `apply`
 * and returns true. A box with no width or height counts as 1px.
 */
export function watchSize(
  host: HTMLElement,
  apply: (width: number, height: number, ratio: number) => void
): () => boolean {
  let width = 0;
  let height = 0;
  let ratio = 0;
  return () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    const r = Math.min(2, window.devicePixelRatio || 1);
    if (w === width && h === height && r === ratio) return false;
    width = w;
    height = h;
    ratio = r;
    apply(w, h, r);
    return true;
  };
}
