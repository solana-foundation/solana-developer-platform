/**
 * Loads the origami scene code, and three.js with it, on demand. It is its own
 * module so tests can replace it: Vitest does not reliably mock a module that
 * several components import dynamically at the same moment.
 */
export function loadOrigami() {
  return import("./mount-origami");
}
