import type { WebGLRenderer } from "three";

/** Whether this browser can make a WebGL context at all, checked before three.js is fetched. */
export function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    /* give the probe's context back at once: browsers allow only a few at a time */
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

export type MountedRenderer = {
  renderer: WebGLRenderer;
  canvas: HTMLCanvasElement;
  /** Lets the context go and takes the canvas out; call it after the scene's own disposals. */
  unmount: () => void;
};

/**
 * The part of a scene's renderer every scene shares: made by `make` (three.js stays with the
 * caller, so this module never pulls it in), at most 2x the screen's density, its canvas first in
 * `host` and hidden from assistive tech, `onLost` called when the context goes. Returns null when
 * the renderer cannot be made.
 */
export function mountRenderer(
  make: () => WebGLRenderer,
  host: HTMLElement,
  { className, onLost }: { className?: string; onLost: () => void }
): MountedRenderer | null {
  let renderer: WebGLRenderer;
  try {
    renderer = make();
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  if (className) canvas.className = className;
  host.insertBefore(canvas, host.firstChild);

  const onContextLost = (event: Event) => {
    event.preventDefault();
    onLost();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  return {
    renderer,
    canvas,
    unmount() {
      canvas.removeEventListener("webglcontextlost", onContextLost);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
