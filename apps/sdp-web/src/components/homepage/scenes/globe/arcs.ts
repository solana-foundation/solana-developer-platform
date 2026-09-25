import * as THREE from "three";
import { easeInOutQuad } from "../easing";
import { CITIES, CITY_KEYS, type CityKey, latLonToVector, pathThrough, routePoints } from "./geo";
import { beamMaterial, type GlobePalette, glowTexture } from "./materials";

export type ArcPhase = "birth" | "draw" | "confirm" | "fade";

export type Arc = {
  core: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial>;
  halo: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial>;
  head: THREE.Sprite;
  destination: THREE.Sprite;
  path: THREE.CurvePath<THREE.Vector3>;
  start: THREE.Vector3;
  end: THREE.Vector3;
  from: CityKey;
  to: CityKey;
  amountIndex: number;
  phase: ArcPhase;
  /** Seconds spent in the current phase (draw uses `progress` instead). */
  life: number;
  progress: number;
  length: number;
};

type Ripple = {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  t: number;
  duration: number;
  size: number;
};

const ROUTE_RADIUS = 1.014;
const BIRTH_S = 0.4;
const HOLD_S = 1.1;
const FADE_S = 1.8;

/**
 * Payments crossing the globe: each arc is born at a visible city, draws
 * along the grid to another, confirms with a ripple, and fades out.
 */
export function createArcs(globe: THREE.Group, palette: GlobePalette) {
  const pink = new THREE.Color(palette.pink);
  const ink = new THREE.Color(palette.ink);
  const green = new THREE.Color(palette.green);
  const pinkGlow = glowTexture(palette.pink);
  const greenGlow = glowTexture(palette.green);
  const ringGeometry = new THREE.RingGeometry(0.88, 1.0, 48);
  const arcs: Arc[] = [];
  const ripples: Ripple[] = [];
  let spawned = 0;

  function ripple(
    point: THREE.Vector3,
    color: THREE.Color,
    size: number,
    duration: number,
    delay = 0
  ) {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(ringGeometry, material);
    mesh.position.copy(point).multiplyScalar(1.006);
    mesh.lookAt(point.clone().multiplyScalar(2));
    mesh.scale.setScalar(0.001);
    globe.add(mesh);
    ripples.push({ mesh, t: -delay, duration, size });
  }

  function stepRipples(dt: number) {
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.t += dt;
      if (r.t < 0) continue;
      const k = Math.min(1, r.t / r.duration);
      r.mesh.scale.setScalar(0.004 + r.size * (1 - (1 - k) ** 3));
      r.mesh.material.opacity = 0.9 * (1 - k) * (1 - k);
      if (k >= 1) {
        globe.remove(r.mesh);
        r.mesh.material.dispose();
        ripples.splice(i, 1);
      }
    }
  }

  function facingCamera(key: CityKey) {
    const [lat, lon] = CITIES[key];
    return latLonToVector(lat, lon, 1).applyQuaternion(globe.quaternion).z > 0.3;
  }

  function pickPair(): [CityKey, CityKey] | null {
    const visible = CITY_KEYS.filter(facingCamera);
    if (visible.length < 2) return null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = visible[Math.floor(Math.random() * visible.length)];
      const b = visible[Math.floor(Math.random() * visible.length)];
      if (a === b) continue;
      const distance = latLonToVector(...CITIES[a], 1).distanceTo(latLonToVector(...CITIES[b], 1));
      if (distance > 0.5) return [a, b];
    }
    return null;
  }

  function sprite(map: THREE.Texture, scale: number, position: THREE.Vector3) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map, transparent: true, opacity: 0, depthWrite: false })
    );
    s.scale.setScalar(scale);
    s.position.copy(position);
    globe.add(s);
    return s;
  }

  /** Starts a payment between two visible cities. `settled` draws it complete and inked. */
  function spawn(settled = false): Arc | null {
    const pair = pickPair();
    if (!pair) return null;
    const points = routePoints(CITIES[pair[0]], CITIES[pair[1]], ROUTE_RADIUS);
    const path = pathThrough(points);
    const segments = Math.min(240, points.length * 3);
    const core = new THREE.Mesh(
      new THREE.TubeGeometry(path, segments, 0.0046, 6, false),
      beamMaterial("core", pink, 1)
    );
    const halo = new THREE.Mesh(
      new THREE.TubeGeometry(path, segments, 0.022, 10, false),
      beamMaterial("halo", pink, 0.3)
    );
    globe.add(halo, core);
    const start = points[0];
    const end = points[points.length - 1];
    const arc: Arc = {
      core,
      halo,
      head: sprite(pinkGlow, 0.08, start),
      destination: sprite(greenGlow, 0.001, end),
      path,
      start,
      end,
      from: pair[0],
      to: pair[1],
      amountIndex: spawned++,
      phase: "birth",
      life: 0,
      progress: 0,
      length: path.getLength(),
    };
    if (settled) {
      setProgress(arc, 1);
      arc.core.material.uniforms.uColor.value.copy(ink);
      arc.halo.material.uniforms.uOpacity.value = 0;
      arc.phase = "confirm";
    } else {
      ripple(start, pink, 0.08, 0.7);
    }
    arcs.push(arc);
    return arc;
  }

  function setProgress(arc: Arc, progress: number) {
    arc.core.material.uniforms.uProgress.value = progress;
    arc.halo.material.uniforms.uProgress.value = progress;
  }

  function remove(arc: Arc) {
    globe.remove(arc.core, arc.halo, arc.head, arc.destination);
    for (const mesh of [arc.core, arc.halo]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    arc.head.material.dispose();
    arc.destination.material.dispose();
  }

  function stepBirth(arc: Arc, dt: number) {
    arc.life += dt;
    const k = Math.min(1, arc.life / BIRTH_S);
    arc.head.material.opacity = k;
    arc.head.scale.setScalar(0.04 + 0.05 * k);
    if (k >= 1) arc.phase = "draw";
  }

  function stepDraw(arc: Arc, dt: number) {
    arc.progress = Math.min(1, arc.progress + dt / (1.1 + arc.length * 0.45));
    const e = easeInOutQuad(arc.progress);
    setProgress(arc, e);
    arc.head.position.copy(arc.path.getPointAt(Math.min(0.999, e)));
    arc.head.scale.setScalar(0.09 + 0.03 * Math.sin(arc.progress * Math.PI));
    if (arc.progress >= 1) {
      arc.phase = "confirm";
      arc.life = 0;
      ripple(arc.end, pink, 0.11, 0.8);
      ripple(arc.end, green, 0.17, 1.0, 0.18);
    }
  }

  function stepConfirm(arc: Arc, dt: number) {
    arc.life += dt;
    const k = Math.min(1, arc.life / 0.6);
    arc.core.material.uniforms.uColor.value.copy(pink).lerp(ink, k);
    arc.core.material.uniforms.uOpacity.value = 1 - 0.5 * k;
    arc.halo.material.uniforms.uOpacity.value = 0.3 * (1 - k);
    arc.head.material.opacity = 1 - k;
    const g = Math.min(1, arc.life / HOLD_S);
    arc.destination.material.opacity = Math.sin(g * Math.PI);
    arc.destination.scale.setScalar(0.06 + 0.09 * g);
    if (arc.life >= HOLD_S) {
      arc.phase = "fade";
      arc.life = 0;
    }
  }

  /** Returns false once the arc has faded out and can be removed. */
  function stepFade(arc: Arc, dt: number) {
    arc.life += dt;
    const k = Math.min(1, arc.life / FADE_S);
    arc.core.material.uniforms.uOpacity.value = 0.5 * (1 - k);
    arc.destination.material.opacity = 0;
    return k < 1;
  }

  function step(dt: number) {
    stepRipples(dt);
    for (let i = arcs.length - 1; i >= 0; i--) {
      const arc = arcs[i];
      if (arc.phase === "birth") stepBirth(arc, dt);
      else if (arc.phase === "draw") stepDraw(arc, dt);
      else if (arc.phase === "confirm") stepConfirm(arc, dt);
      else if (!stepFade(arc, dt)) {
        remove(arc);
        arcs.splice(i, 1);
      }
    }
  }

  function dispose() {
    for (const arc of arcs) remove(arc);
    arcs.length = 0;
    for (const r of ripples) {
      globe.remove(r.mesh);
      r.mesh.material.dispose();
    }
    ripples.length = 0;
    ringGeometry.dispose();
    pinkGlow.dispose();
    greenGlow.dispose();
  }

  return { arcs: arcs as readonly Arc[], spawn, step, dispose };
}
