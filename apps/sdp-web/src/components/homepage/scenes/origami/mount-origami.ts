import * as THREE from "three";
import { createRenderer } from "../renderer";
import { watchSize } from "../size";
import { ORIGAMI_BUILDS, type OrigamiKind } from "./builds";
import { FORM_IN_SECONDS, makeFormable } from "./form-in";

export type OrigamiOptions = {
  kind: OrigamiKind;
  ground: "paper" | "dark";
  reducedMotion: boolean;
  /** Camera distance; the design tunes it per scene. */
  zoom: number;
};

export type OrigamiHandle = {
  /** A paused scene holds still and resumes where it stopped. */
  setPlaying: (playing: boolean) => void;
  dispose: () => void;
};

/**
 * Draws one small origami scene into `host`. Each time it comes into view its
 * parts form in (outline, purple, finished skin); its own motion runs only
 * while playing. Returns null when WebGL is unavailable.
 */
export function mountOrigami(host: HTMLElement, options: OrigamiOptions): OrigamiHandle | null {
  const renderer = createRenderer({ antialias: true, alpha: true });
  if (!renderer) return null;
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  host.appendChild(canvas);

  // Built with a stand-in material; the form-in gives every mesh its own.
  const placeholder = new THREE.MeshBasicMaterial();
  const build = ORIGAMI_BUILDS[options.kind](placeholder);
  const formable = makeFormable(build.group, options.ground);
  const scene = new THREE.Scene();
  scene.add(build.group);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, options.zoom);
  camera.lookAt(0, 0, 0);

  const resize = watchSize(host, (w, h) => {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  const render = () => renderer.render(scene, camera);

  // Each scene starts at its own point in its loop, so the three never move in step.
  const offset = Math.random() * 7;
  let playing = false;
  let frameId = 0;
  let observer: IntersectionObserver | null = null;
  let onResize: (() => void) | null = null;

  resize();
  if (options.reducedMotion) {
    // Drawn once, formed and still; redrawn only when its box changes size.
    build.tick(offset);
    formable.finish();
    render();
    onResize = () => {
      if (resize()) render();
    };
    window.addEventListener("resize", onResize);
  } else {
    let visible = false;
    let sceneTime = 0;
    let formTime = 0;
    let last = performance.now();
    observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? false;
        // Leaving the screen resets the form-in, so it plays again on the way back.
        if (!visible) formTime = 0;
      },
      { threshold: 0 }
    );
    observer.observe(host);

    const frame = (now: number) => {
      frameId = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible) return;
      const resized = resize();
      const forming = formTime < FORM_IN_SECONDS;
      // Nothing moves: a paused, formed scene is left as it was drawn.
      if (!playing && !forming && !resized) return;
      if (playing) sceneTime += dt;
      formTime += dt;
      build.tick(sceneTime + offset);
      formable.play(formTime);
      render();
    };
    frameId = requestAnimationFrame(frame);
  }

  return {
    setPlaying: (next) => {
      playing = next;
    },
    dispose: () => {
      cancelAnimationFrame(frameId);
      observer?.disconnect();
      if (onResize) window.removeEventListener("resize", onResize);
      const geometries = new Set<THREE.BufferGeometry>();
      build.group.traverse((object) => {
        if (object instanceof THREE.Mesh) geometries.add(object.geometry);
      });
      for (const geometry of geometries) geometry.dispose();
      formable.dispose();
      placeholder.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
