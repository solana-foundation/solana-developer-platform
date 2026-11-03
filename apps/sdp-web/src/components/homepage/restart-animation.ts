/*
 * Restarting a one-shot CSS animation: take its trigger off, force a style flush so the browser
 * sees the element without it, and put it back. The flush on its own also lets a caller switch
 * transitions off and on around a class change.
 */

/** Forces a synchronous style and layout flush on `el`. */
export function reflow(el: Element): void {
  void el.getBoundingClientRect();
}

/** Restarts the animation an empty attribute such as `data-beat` triggers. */
export function restartAttribute(el: Element | null, name: string): void {
  if (!el) return;
  el.removeAttribute(name);
  reflow(el);
  el.setAttribute(name, "");
}

/** Restarts the animation a class triggers. */
export function restartClass(el: Element | null, className: string): void {
  if (!el) return;
  el.classList.remove(className);
  reflow(el);
  el.classList.add(className);
}
