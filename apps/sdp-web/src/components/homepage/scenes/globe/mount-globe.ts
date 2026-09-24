import * as THREE from "three";
import { easeOutCubic } from "../easing";
import { createRenderer } from "../renderer";
import { watchSize } from "../size";
import { type Arc, createArcs } from "./arcs";
import { graticulePoints, latLonToVector } from "./geo";
import land from "./land.json";
import { GLOBE_PALETTES, type GlobeGround, gridMaterial, silverMatcap } from "./materials";

export type GlobeTags = {
  from: HTMLElement;
  to: HTMLElement;
  /** Called when the labelled payment changes, so the caller can render its text. */
  onArcChange: (arc: Pick<Arc, "from" | "to" | "amountIndex"> | null) => void;
};

export type GlobeOptions = {
  ground: GlobeGround;
  reducedMotion: boolean;
  tags?: GlobeTags;
};

const RADIUS = 1;
const REST_TILT = 0.34;
const CAMERA_Z = 3.95;

/**
 * Draws the wireframe globe into `host` and runs it until the returned
 * dispose function is called. Returns null when WebGL is unavailable, so the
 * caller can keep its static fallback.
 */
export function mountGlobe(host: HTMLElement, options: GlobeOptions): (() => void) | null {
  const renderer = createRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  if (!renderer) return null;
  const { reducedMotion, tags } = options;
  const palette = GLOBE_PALETTES[options.ground];

  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  host.insertBefore(canvas, host.firstChild);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.08, CAMERA_Z);
  const globe = new THREE.Group();
  globe.rotation.set(REST_TILT, -1.15, 0);
  scene.add(globe);

  // The page's own colour just under the surface, so the far side is not drawn through.
  const occluder = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS * 0.992, 64, 40),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(palette.ground),
      transparent: true,
      opacity: reducedMotion ? 1 : 0,
    })
  );
  occluder.renderOrder = -1;
  globe.add(occluder);

  const grid = gridMaterial(palette, reducedMotion ? 1 : 0);
  const gridGeometry = new THREE.BufferGeometry().setFromPoints(graticulePoints(RADIUS * 1.001));
  globe.add(new THREE.LineSegments(gridGeometry, grid));

  // Every coastline is a thin silver tube, drawn in over the first seconds.
  const matcap = silverMatcap(palette.silver);
  const landMaterial = new THREE.MeshMatcapMaterial({ matcap, transparent: true, opacity: 1 });
  const coastlines: { mesh: THREE.Mesh<THREE.TubeGeometry>; total: number }[] = [];
  for (const line of land) {
    if (line.length < 3) continue;
    const points = line.map(([lon, lat]) => latLonToVector(lat, lon, RADIUS * 1.004));
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5);
    const segments = Math.min(1600, Math.max(8, points.length * 2));
    const geometry = new THREE.TubeGeometry(curve, segments, 0.0038, 5, false);
    const total = geometry.index?.count ?? 0;
    if (!reducedMotion) geometry.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geometry, landMaterial);
    coastlines.push({ mesh, total });
    globe.add(mesh);
  }
  const drawLand = (fraction: number) => {
    for (const { mesh, total } of coastlines)
      mesh.geometry.setDrawRange(0, Math.floor(total * fraction));
  };

  const arcs = createArcs(globe, palette);

  // placeTag reads the box's size to put the tags in CSS pixels.
  let width = 0;
  let height = 0;
  const resize = watchSize(host, (w, h) => {
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = CAMERA_Z * (w >= h ? 1 : Math.min(1.3, h / w));
    camera.updateProjectionMatrix();
  });

  const projected = new THREE.Vector3();
  function placeTag(tag: HTMLElement, point: THREE.Vector3, show: boolean) {
    projected.copy(point).applyMatrix4(globe.matrixWorld);
    const front = projected.z > 0.12;
    projected.project(camera);
    const x = ((projected.x + 1) / 2) * width;
    const y = ((1 - projected.y) / 2) * height;
    tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    tag.dataset.visible = String(show && front);
  }

  let labelled: Arc | null = null;
  function stepTags() {
    if (!tags) return;
    const arc = arcs.arcs.find((a) => a.phase !== "fade" || a.life < 0.5) ?? null;
    if (arc !== labelled) {
      labelled = arc;
      tags.onArcChange(arc);
    }
    if (!arc) {
      tags.from.dataset.visible = "false";
      tags.to.dataset.visible = "false";
      return;
    }
    const departing = arc.phase === "birth" || arc.phase === "draw";
    placeTag(tags.from, arc.start, departing || (arc.phase === "confirm" && arc.life < 0.5));
    placeTag(tags.to, arc.end, arc.phase === "confirm" || (arc.phase === "fade" && arc.life < 0.5));
  }

  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(
    target: Window | HTMLElement,
    type: K,
    handler: (event: WindowEventMap[K]) => void
  ) => {
    target.addEventListener(type, handler as EventListener, { passive: true });
    cleanups.push(() => target.removeEventListener(type, handler as EventListener));
  };

  resize();

  if (reducedMotion) {
    // Drawn once, complete, with two settled routes.
    globe.updateMatrixWorld();
    arcs.spawn(true);
    arcs.spawn(true);
    renderer.render(scene, camera);
    listen(window, "resize", () => {
      resize();
      renderer.render(scene, camera);
    });
  } else {
    // Turned by hand: drag, let go, it drifts on.
    let drag: { x: number; y: number; t: number } | null = null;
    let spinY = 0;
    let spinX = 0;
    let idle = 0;
    canvas.style.cursor = "grab";
    canvas.style.touchAction = "pan-y";
    listen(canvas, "pointerdown", (event) => {
      drag = { x: event.clientX, y: event.clientY, t: performance.now() };
      spinY = 0;
      spinX = 0;
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(event.pointerId);
    });
    listen(canvas, "pointermove", (event) => {
      if (!drag) return;
      const now = performance.now();
      const seconds = Math.max(1, now - drag.t) / 1000;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      globe.rotation.y += dx * 0.006;
      globe.rotation.x = Math.max(-0.9, Math.min(0.9, globe.rotation.x + dy * 0.004));
      spinY = (dx * 0.006) / seconds;
      spinX = (dy * 0.004) / seconds;
      drag = { x: event.clientX, y: event.clientY, t: now };
      idle = 0;
    });
    const letGo = () => {
      drag = null;
      canvas.style.cursor = "grab";
    };
    listen(canvas, "pointerup", letGo);
    listen(canvas, "pointercancel", letGo);
    listen(canvas, "pointerleave", letGo);

    // The camera leans a little toward the pointer.
    let leanX = 0;
    let leanY = 0;
    let targetX = 0;
    let targetY = 0;
    listen(window, "pointermove", (event) => {
      if (drag) return;
      targetX = (event.clientX / window.innerWidth - 0.5) * 0.22;
      targetY = (event.clientY / window.innerHeight - 0.5) * 0.12;
    });

    let visible = true;
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0.02 }
    );
    observer.observe(host);
    cleanups.push(() => observer.disconnect());

    let last = performance.now();
    let elapsed = 0;
    let spawnIn = 2.4;
    let frameId = 0;
    const frame = (now: number) => {
      frameId = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible) return;
      elapsed += dt;
      resize();

      grid.uniforms.uReveal.value = easeOutCubic(elapsed / 1.6);
      occluder.material.opacity = easeOutCubic(elapsed / 1.0);
      landMaterial.opacity = easeOutCubic((elapsed - 0.2) / 1.0);
      drawLand(easeOutCubic((elapsed - 0.3) / 2.6));
      globe.scale.setScalar(0.94 + 0.06 * easeOutCubic(elapsed / 1.8));

      if (!drag) {
        // A push dies down, then the slow turn comes back on its own.
        globe.rotation.y += spinY * dt;
        globe.rotation.x += spinX * dt;
        spinY *= 0.94;
        spinX *= 0.9;
        idle += dt;
        globe.rotation.y += dt * 0.045 * Math.min(1, Math.max(0, idle - 1.2));
        if (Math.abs(spinX) < 0.01) globe.rotation.x += (REST_TILT - globe.rotation.x) * 0.01;
      }
      leanX += (targetX - leanX) * 0.04;
      leanY += (targetY - leanY) * 0.04;
      camera.position.x = leanX;
      camera.position.y = 0.08 - leanY;
      camera.lookAt(0, 0, 0);
      globe.updateMatrixWorld();

      spawnIn -= dt;
      if (elapsed > 2.2 && spawnIn <= 0 && arcs.arcs.length < 2 && arcs.spawn()) {
        spawnIn = 2.6 + Math.random() * 1.6;
      }
      arcs.step(dt);
      stepTags();
      renderer.render(scene, camera);
    };
    frameId = requestAnimationFrame(frame);
    cleanups.push(() => cancelAnimationFrame(frameId));
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
    arcs.dispose();
    for (const { mesh } of coastlines) mesh.geometry.dispose();
    landMaterial.dispose();
    matcap.dispose();
    gridGeometry.dispose();
    grid.dispose();
    occluder.geometry.dispose();
    occluder.material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
