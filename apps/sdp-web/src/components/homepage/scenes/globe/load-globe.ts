/**
 * Loads the globe scene code, and three.js with it, on demand. It is its own
 * module so tests can replace it, as with the origami scenes (load-origami.ts).
 */
export function loadGlobe() {
  return import("./mount-globe");
}
