import * as THREE from "three";

/**
 * A WebGL renderer for one scene, capped at 2x pixel density, its canvas hidden
 * from assistive technology. Returns null where WebGL is unavailable, so the
 * caller can keep its static fallback.
 */
export function createRenderer(
  parameters: THREE.WebGLRendererParameters
): THREE.WebGLRenderer | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer(parameters);
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute("aria-hidden", "true");
  return renderer;
}
