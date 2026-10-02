import * as THREE from "three";
import { createRenderer } from "../renderer";
import { watchSize } from "../size";
import { FILMS, filmUrl } from "./films";
import { buildRing, PER_ROW } from "./ring";
import { makeShot, TURNS } from "./shot";

export type BuildersOptions = {
  reducedMotion: boolean;
  /** Called every drawn frame with how far through the shot the camera is, 0..1. */
  onProgress: (progress: number) => void;
};

/** Where the camera rests under reduced motion: outside the ring, the ring under the words. */
const STILL_PROGRESS = 0.1;
/** The scroll is followed with a little lag, as the reference smooths it. */
const FOLLOW = 0.07;

/**
 * The builders' ring: a cylinder of interview stills that the camera flies
 * round, into and out of as `section` scrolls past; `stage` is the pinned
 * box it draws in. A click on a still opens that interview. Returns null
 * without WebGL.
 */
export function mountBuilders(
  section: HTMLElement,
  stage: HTMLElement,
  options: BuildersOptions
): (() => void) | null {
  const renderer = createRenderer({ antialias: true, powerPreference: "high-performance" });
  if (!renderer) return null;
  renderer.setClearColor(0x08080a, 1);
  const canvas = renderer.domElement;
  stage.insertBefore(canvas, stage.firstChild);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  const look = new THREE.Vector3();
  const gl = renderer.getContext();
  const ring = buildRing(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096);
  scene.add(ring.group, ...ring.streaks.lines);
  const placeCamera = makeShot(window.innerWidth);

  const resize = watchSize(stage, (w, h) => {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  const scrollProgress = () => {
    if (options.reducedMotion) return STILL_PROGRESS;
    const rect = section.getBoundingClientRect();
    const travel = rect.height - window.innerHeight;
    return travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 1;
  };

  // A click (not a drag) on a still opens that interview.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const filmAt = (clientX: number, clientY: number) => {
    const box = canvas.getBoundingClientRect();
    pointer.set(
      ((clientX - box.left) / box.width) * 2 - 1,
      -((clientY - box.top) / box.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(ring.faces, false)[0];
    if (!hit?.uv) return null;
    const face = hit.object as (typeof ring.faces)[number];
    const u = face.material.side === THREE.BackSide ? 1 - hit.uv.x : hit.uv.x;
    return FILMS[face.userData.row * PER_ROW + Math.min(PER_ROW - 1, Math.floor(u * PER_ROW))];
  };
  let pressedAt: [number, number] | null = null;
  const onPointerMove = (event: PointerEvent) => {
    canvas.style.cursor = filmAt(event.clientX, event.clientY) ? "pointer" : "";
  };
  const onPointerDown = (event: PointerEvent) => {
    pressedAt = [event.clientX, event.clientY];
  };
  const onPointerUp = (event: PointerEvent) => {
    const moved = pressedAt
      ? Math.hypot(event.clientX - pressedAt[0], event.clientY - pressedAt[1])
      : Number.POSITIVE_INFINITY;
    pressedAt = null;
    if (moved > 6) return;
    const film = filmAt(event.clientX, event.clientY);
    if (film) window.open(filmUrl(film[0]), "_blank", "noopener");
  };
  canvas.addEventListener("pointermove", onPointerMove, { passive: true });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);

  let visible = false;
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries[0]?.isIntersecting ?? false;
    },
    { threshold: 0 }
  );
  observer.observe(section);

  let progress = scrollProgress();
  let lastTurn = ring.group.rotation.y;
  let frameId = 0;
  const frame = () => {
    frameId = requestAnimationFrame(frame);
    if (!visible) return;
    resize();
    const target = scrollProgress();
    progress += options.reducedMotion ? target - progress : (target - progress) * FOLLOW;
    if (Math.abs(target - progress) < 0.0004) progress = target;

    placeCamera(progress, camera, look);
    ring.group.rotation.y = 0.5 + TURNS * Math.PI * 2 * progress;
    const turn = ring.group.rotation.y - lastTurn;
    lastTurn = ring.group.rotation.y;
    // The faster it turns, the softer the stills: a little motion blur.
    const blur = options.reducedMotion
      ? 0
      : Math.min(5, Math.max(0, (Math.abs(turn) * 100 - 0.6) * 1.6));
    canvas.style.filter = blur > 0.15 ? `blur(${blur.toFixed(1)}px)` : "";
    ring.streaks.step(options.reducedMotion ? 0 : turn);

    options.onProgress(progress);
    renderer.render(scene, camera);
  };
  frameId = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(frameId);
    observer.disconnect();
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    ring.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
