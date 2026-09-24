/**
 * Loads the builders' ring, and three.js with it, on demand; its own module so
 * tests can replace it, as with the other scenes (load-origami.ts).
 */
export function loadBuilders() {
  return import("./mount-builders");
}
