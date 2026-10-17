/*
 * The planet. A sphere that turns and can be turned by hand, its coasts drawn as lines.
 *
 * Payments, one at a time: a dashed route is drawn in as a payment leaves, a mint signal flies it
 * and the dashes it passes turn mint; the moment it touches the far pin it has landed: two rings
 * open, the pin turns mint and beats once, its coast lights, and the line clears. The two latest
 * landings stay lit. Two tags ride the surface: what left and from where; that it was confirmed
 * and where. Under reduced motion it does not drift, shows one payment already landed, and stops
 * drawing once it has faded in.
 *
 * This module pulls in three.js and the coast data, so it is only ever imported dynamically.
 */
import * as THREE from "three";
import { easeOutCubic as ease } from "@/lib/easing";
import { mountRenderer } from "@/lib/webgl";
import { GLOBE_DRAWING, landGeometry, latLon } from "./coasts";
import { AMOUNTS, type Amount, CITIES, type GlobeLabels } from "./payments";
import { ARC_FRAG, LAND_FRAG, LINE_VERT, RIM_FRAG, RIM_VERT } from "./shaders";
import { discTexture, haloTexture, ringTexture } from "./textures";

const COL = { ground: "#FBFAF9", grey: "#DEDEDD", mint: "#79E8B9" };
const CITY_KEYS = Object.keys(CITIES);
/* the reduced-motion scene stops drawing once everything has faded in */
const SETTLED_AFTER = 3;
/* the reference's per-frame decays at 60fps, as rates per second: a flung globe keeps 94% of its
   turn and 90% of its tilt a frame, and tilts back 1% of the way a frame */
const SPIN_DECAY = -Math.log(0.94) * 60;
const TILT_DECAY = -Math.log(0.9) * 60;
const TILT_RETURN = -Math.log(0.99) * 60;

/* the coasts take a while to build: built once per page and copied for each scene, so a remount
   (or a change of reduced motion) does not build them again; a scene disposes only its copy */
let landCache: THREE.BufferGeometry | null = null;
function land() {
  landCache ??= landGeometry();
  return landCache.clone();
}

export type GlobeTag = HTMLElement;

export type GlobeSceneOptions = {
  host: HTMLElement;
  tagFrom: GlobeTag;
  tagTo: GlobeTag;
  labels: GlobeLabels;
  reduced: boolean;
  /** WebGL went away (context lost): the caller shows its static globe instead. */
  onLost: () => void;
};

export type GlobeScene = {
  /** Draws while the globe is on screen and the tab is visible; rests otherwise. */
  setActive: (active: boolean) => void;
  dispose: () => void;
};

type Flight = {
  pair: [string, string];
  path: THREE.CatmullRomCurve3;
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial>;
  a: THREE.Vector3;
  b: THREE.Vector3;
  pa: THREE.Sprite;
  pb: THREE.Sprite;
  head: THREE.Sprite;
  glow: THREE.Sprite;
  life: number;
  prog: number;
  arrived: boolean;
  arrivedAt: number;
  gone: number | null;
  amount: Amount;
};

type Mark = { at: THREE.Vector3; pin: THREE.Sprite; w: number; beat: number | null };
type Bloom = { sprite: THREE.Sprite; t: number; size: number; soft: boolean };

function cityPoint(key: string, r = 1) {
  const city = CITIES[key];
  return latLon(city.lat, city.lon, r);
}

function arcPath(from: string, to: string) {
  const a = cityPoint(from).normalize();
  const b = cityPoint(to).normalize();
  const angle = a.angleTo(b);
  const sin = Math.sin(angle);
  const lift = 0.02 + (0.09 * angle) / Math.PI;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 96; i++) {
    const t = i / 96;
    const wa = Math.sin((1 - t) * angle) / sin;
    const wb = Math.sin(t * angle) / sin;
    points.push(
      new THREE.Vector3()
        .addScaledVector(a, wa)
        .addScaledVector(b, wb)
        .normalize()
        .multiplyScalar(1.008 + lift * Math.sin(Math.PI * t))
    );
  }
  return new THREE.CatmullRomCurve3(points);
}

/**
 * Mounts the globe in `host`. Returns null when a WebGL renderer cannot be made, so the caller
 * can show its static globe.
 */
export function createGlobeScene({
  host,
  tagFrom,
  tagTo,
  labels,
  reduced,
  onLost,
}: GlobeSceneOptions): GlobeScene | null {
  const mounted = mountRenderer(
    () => new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "default" }),
    host,
    { onLost }
  );
  if (!mounted) return null;
  const { renderer, canvas } = mounted;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.06, 3.95);
  const globe = new THREE.Group();
  globe.rotation.x = 0.3;
  globe.rotation.y = -1.25;
  scene.add(globe);

  /* the mint field: up to four landings, each with a weight of its own, so a coast lights as
     money lands on it and lets go as later ones take over */
  const hot = [0, 1, 2, 3].map(() => new THREE.Vector3(9, 9, 9));
  const hotW = [0, 0, 0, 0];
  const field = {
    uHot: { value: hot },
    uHotW: { value: hotW },
    uInk: { value: GLOBE_DRAWING.ink },
  };

  const occluder = new THREE.Mesh(
    new THREE.SphereGeometry(0.994, 64, 40),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(COL.ground),
      transparent: true,
      opacity: 0,
    })
  );
  occluder.renderOrder = -1;
  globe.add(occluder);

  /* the rim: a faint band facing the viewer */
  const rimMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: RIM_VERT,
    fragmentShader: RIM_FRAG,
  });
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(1.034 - 0.0027, 1.034 + 0.0027, 256),
    rimMaterial
  );
  scene.add(rim);

  const landMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: 0 }, ...field },
    vertexShader: LINE_VERT,
    fragmentShader: LAND_FRAG,
  });
  const coastline = new THREE.Mesh(land(), landMaterial);
  coastline.renderOrder = 1;
  globe.add(coastline);

  const DISC = discTexture();
  const RING = ringTexture();
  const HALO = haloTexture();

  function sprite(map: THREE.Texture, color: string, size: number, order: number) {
    const material = new THREE.SpriteMaterial({
      map,
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const s = new THREE.Sprite(material);
    s.scale.setScalar(size);
    s.renderOrder = order;
    globe.add(s);
    return s;
  }
  function removeSprite(s: THREE.Sprite) {
    globe.remove(s);
    s.material.dispose();
  }

  function arcMesh(path: THREE.CatmullRomCurve3, order: number) {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uOpacity: { value: 0 },
        uDashes: { value: path.getLength() / 0.024 },
        uDraw: { value: 1 },
        uProg: { value: -1 },
        uMint: { value: 0 },
        ...field,
      },
      vertexShader: LINE_VERT,
      fragmentShader: ARC_FRAG,
    });
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, 192, 0.0026, 6, false), material);
    mesh.renderOrder = order;
    globe.add(mesh);
    return mesh;
  }

  const facing = (v: THREE.Vector3) => v.clone().normalize().applyQuaternion(globe.quaternion).z;
  const seen = (v: THREE.Vector3) => ease((facing(v) - 0.12) / 0.3);

  /* the landings: a mint pin where money arrived, lighting its coast. The two latest stay lit;
     older ones let go. Nothing is lit that nothing reached */
  const marks: Mark[] = [];
  function mark(at: THREE.Vector3) {
    const pin = sprite(DISC, COL.mint, 0.029, 7);
    pin.position.copy(at);
    const m: Mark = { at: at.clone().normalize(), pin, w: 0, beat: 0 };
    marks.push(m);
  }

  /* the rings: a fine one opening where a payment leaves, two where it lands, and a soft bloom
     under them */
  const blooms: Bloom[] = [];
  function ripple(at: THREE.Vector3, color: string, delay: number, size: number, soft = false) {
    const s = sprite(soft ? HALO : RING, color, 0.01, soft ? 4 : 5);
    s.position.copy(at).multiplyScalar(1.002);
    blooms.push({ sprite: s, t: -delay, size, soft });
  }

  /* one payment at a time between two cities that face the viewer */
  const flights: Flight[] = [];
  let current: Flight | null = null;
  let launched = 0;
  function pickPair(): [string, string] | null {
    const visible = CITY_KEYS.filter((key) => facing(cityPoint(key)) > 0.35);
    for (let i = 0; i < 20; i++) {
      const a = visible[Math.floor(Math.random() * visible.length)];
      const b = visible[Math.floor(Math.random() * visible.length)];
      if (!a || !b || a === b || current?.pair[1] === b) continue;
      const d = cityPoint(a).distanceTo(cityPoint(b));
      if (d > 0.55 && d < 1.5) return [a, b];
    }
    return null;
  }
  function launch() {
    const pair = pickPair();
    if (!pair) return false;
    const path = arcPath(pair[0], pair[1]);
    const mesh = arcMesh(path, 4);
    mesh.material.uniforms.uDraw.value = 0;
    mesh.material.uniforms.uProg.value = 0;
    mesh.material.uniforms.uMint.value = 1;
    const flight: Flight = {
      pair,
      path,
      mesh,
      a: path.getPointAt(0),
      b: path.getPointAt(1),
      pa: sprite(DISC, COL.grey, 0.029, 6),
      pb: sprite(DISC, COL.grey, 0.029, 6),
      head: sprite(DISC, COL.mint, 0.021, 9),
      glow: sprite(HALO, COL.mint, 0.1, 8),
      life: 0,
      prog: -0.2,
      arrived: false,
      arrivedAt: 0,
      gone: null,
      amount: AMOUNTS[launched++ % AMOUNTS.length],
    };
    flight.pa.position.copy(flight.a);
    flight.pb.position.copy(flight.b);
    flights.push(flight);
    current = flight;
    ripple(flight.a, "#9C98A8", 0, 0.08);
    return true;
  }
  function arrive(flight: Flight) {
    flight.arrived = true;
    flight.arrivedAt = flight.life;
    flight.gone = -1.1; /* the line rests a moment, then clears */
    mark(flight.b);
    ripple(flight.b, "#14F195", 0, 0.1, true);
    ripple(flight.b, "#14F195", 0, 0.12);
    ripple(flight.b, "#14F195", 0.38, 0.09);
  }
  function drop(flight: Flight) {
    globe.remove(flight.mesh);
    flight.mesh.geometry.dispose();
    flight.mesh.material.dispose();
    for (const s of [flight.pa, flight.pb, flight.head, flight.glow]) removeSprite(s);
    flights.splice(flights.indexOf(flight), 1);
  }

  /* the tags: what left and from where; that it arrived, and where */
  let tagFlight: Flight | null = null;
  let tagFromOut = false;
  let tagToOut = false;
  const projected = new THREE.Vector3();
  /* each tag's size, measured once when its words change, so placing it each frame reads no
     layout */
  const tagSize = new Map<GlobeTag, { width: number; height: number }>();
  function measure(tag: GlobeTag) {
    tagSize.set(tag, { width: tag.offsetWidth, height: tag.offsetHeight });
  }
  function writeTags(flight: Flight) {
    const fromFigure = tagFrom.querySelector("b");
    const fromLine = tagFrom.querySelector("span");
    const toFigure = tagTo.querySelector("b");
    const toLine = tagTo.querySelector("span");
    if (fromFigure) {
      fromFigure.textContent = `${flight.amount.figure} `;
      const currency = document.createElement("i");
      currency.textContent = flight.amount.currency;
      fromFigure.appendChild(currency);
    }
    if (fromLine) fromLine.textContent = labels.from(CITIES[flight.pair[0]].name);
    if (toFigure) toFigure.textContent = labels.confirmed;
    if (toLine) toLine.textContent = labels.landed(CITIES[flight.pair[1]].name);
    measure(tagFrom);
    measure(tagTo);
  }
  /* a write only when the value changes */
  function setData(tag: GlobeTag, key: "on" | "flip", value: boolean) {
    const next = String(value);
    if (tag.dataset[key] !== next) tag.dataset[key] = next;
  }
  /* places a tag level with its pin and joined to it by a hairline; it flips to the other side
     of the pin rather than be cut by the edge of the screen */
  function place(tag: GlobeTag, point: THREE.Vector3, show: boolean, out: boolean) {
    projected.copy(point).applyMatrix4(globe.matrixWorld);
    const front = projected.z > 0.15;
    projected.project(camera);
    const px = ((projected.x + 1) / 2) * width;
    const py = ((1 - projected.y) / 2) * height;
    const GAP = 22;
    const PIN = 6;
    const minX = 16 - hostLeft;
    const maxX = Math.min(width, viewportWidth - hostLeft) - 16;
    const { width: tagWidth, height: tagHeight } = tagSize.get(tag) ?? { width: 0, height: 0 };
    let flip = px + GAP + tagWidth > maxX;
    let tx = flip ? px - tagWidth - GAP : Math.max(minX, px + GAP);
    if (flip && tx < minX) {
      flip = false;
      tx = Math.max(minX, maxX - tagWidth);
    }
    const fits = tx + tagWidth <= maxX && (flip || tx >= px + PIN);
    const nowOut = out || (show && front && !fits);
    setData(tag, "flip", flip);
    tag.style.transform = `translate(${tx.toFixed(1)}px,${(py - tagHeight / 2).toFixed(1)}px)`;
    setData(tag, "on", show && front && !nowOut);
    return nowOut;
  }
  function stepTags() {
    const flight = current;
    if (!flight || flight.life < 0.3) {
      setData(tagFrom, "on", false);
      setData(tagTo, "on", false);
      return;
    }
    if (tagFlight !== flight) {
      tagFlight = flight;
      tagFromOut = false;
      tagToOut = false;
      writeTags(flight);
    }
    const hold = width < 600 ? 0 : 0.5;
    tagFromOut = place(
      tagFrom,
      flight.a,
      !flight.arrived || flight.life - flight.arrivedAt < hold,
      tagFromOut
    );
    tagToOut = place(tagTo, flight.b, flight.arrived, tagToOut);
  }

  /* turned by hand; let go and it drifts on */
  let drag: { x: number; y: number; t: number } | null = null;
  let velY = 0;
  let velX = 0;
  let idle = 0;
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "pan-y";
  const onPointerDown = (event: PointerEvent) => {
    drag = { x: event.clientX, y: event.clientY, t: performance.now() };
    velY = 0;
    velX = 0;
    canvas.style.cursor = "grabbing";
    canvas.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const now = performance.now();
    const dt = Math.max(1, now - drag.t) / 1000;
    globe.rotation.y += dx * 0.006;
    globe.rotation.x = THREE.MathUtils.clamp(globe.rotation.x + dy * 0.004, -0.9, 0.9);
    velY = (dx * 0.006) / dt;
    velX = (dy * 0.004) / dt;
    drag = { x: event.clientX, y: event.clientY, t: now };
    idle = 0;
    wake();
  };
  const letGo = () => {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = "grab";
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", letGo);
  canvas.addEventListener("pointercancel", letGo);
  canvas.addEventListener("pointerleave", letGo);

  let width = 0;
  let height = 0;
  /* where the box sits across the window, for keeping the tags on screen; read on a resize or a
     scroll (the hero's parallax scales the box), never while placing the tags */
  let hostLeft = 0;
  let viewportWidth = window.innerWidth;
  function readPlace() {
    hostLeft = host.getBoundingClientRect().left;
    viewportWidth = window.innerWidth;
  }
  function resize() {
    readPlace();
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    camera.position.z = 3.95 * (w >= h ? 1 : Math.min(1.3, h / w));
  }
  resize();
  const resizeObserver = new ResizeObserver(() => {
    resize();
    wake();
  });
  resizeObserver.observe(host);

  /* time since the globe first drew, counting only the time it was on screen */
  let t = 0;
  let nextIn = 2.4;
  let raf = 0;
  let last = 0;
  let active = false;

  /* the planet fades and grows in, and drifts on its own once let go */
  function stepGlobe(dt: number) {
    occluder.material.opacity = ease(t / 1.0);
    rimMaterial.uniforms.uOpacity.value = ease(t / 1.4);
    landMaterial.uniforms.uOpacity.value = ease((t - 0.2) / 1.6);
    globe.scale.setScalar(0.95 + 0.05 * ease(t / 1.8));
    if (!drag && !reduced) {
      globe.rotation.y += velY * dt;
      globe.rotation.x += velX * dt;
      velY = THREE.MathUtils.damp(velY, 0, SPIN_DECAY, dt);
      velX = THREE.MathUtils.damp(velX, 0, TILT_DECAY, dt);
      idle += dt;
      globe.rotation.y += dt * 0.05 * THREE.MathUtils.clamp(idle - 1, 0, 1);
      if (Math.abs(globe.rotation.x - 0.3) > 0.001 && Math.abs(velX) < 0.01) {
        globe.rotation.x = THREE.MathUtils.damp(globe.rotation.x, 0.3, TILT_RETURN, dt);
      }
    }
    globe.updateMatrixWorld();
  }

  /* a new payment every 4.4s; when no pair of cities faces us, look again shortly. Under reduced
     motion one payment is shown already landed, and stays */
  function schedule(dt: number) {
    if (!reduced) {
      nextIn -= dt;
      if (t > 2.4 && nextIn <= 0) nextIn = launch() ? 4.4 : 0.3;
      return;
    }
    if (flights.length || !launch()) return;
    const flight = flights[0];
    flight.life = 9;
    flight.prog = 1;
    arrive(flight);
    flight.gone = null;
    flight.arrivedAt = -9;
    marks[marks.length - 1].beat = null;
    for (const bloom of blooms.splice(0)) removeSprite(bloom.sprite);
  }

  function stepFlight(flight: Flight, dt: number, show: number) {
    flight.life += dt;
    const u = flight.mesh.material.uniforms;
    u.uDraw.value = ease(flight.life / 0.6);
    if (!flight.arrived) {
      flight.prog += dt * 0.6;
      if (flight.prog >= 1) arrive(flight);
    }
    const p = THREE.MathUtils.clamp(flight.prog, 0, 1);
    u.uProg.value = p;
    if (flight.gone != null) flight.gone += dt;
    const fade = flight.gone == null ? 1 : 1 - ease(flight.gone / 0.8);
    u.uOpacity.value = show * fade;
    flight.pa.material.opacity = show * fade * seen(flight.a) * ease(flight.life / 0.4);
    flight.pb.material.opacity = flight.arrived
      ? 0
      : show * seen(flight.b) * ease(flight.life / 0.4);
    /* the signal: a mint point with a soft glow, riding the route head first */
    const at = flight.path.getPointAt(p);
    flight.head.position.copy(at);
    flight.glow.position.copy(at);
    const flying = flight.prog > 0 && !flight.arrived ? 1 : 0;
    const visible = seen(at);
    const k = Math.min(1, dt * 14);
    flight.head.material.opacity += (flying * visible - flight.head.material.opacity) * k;
    flight.glow.material.opacity += (0.5 * flying * visible - flight.glow.material.opacity) * k;
    if (flight.gone != null && flight.gone > 0.8) drop(flight);
  }

  /* the landings: the two latest lit, the rest letting go; each pin beats once as money lands */
  function stepMarks(dt: number, show: number) {
    const keep = marks.length - 2;
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      const want = i >= keep ? 1 : 0;
      m.w += (want - m.w) * Math.min(1, dt * (want ? 2.6 : 0.9));
      if (m.beat != null) m.beat = m.beat + dt > 1.2 ? null : m.beat + dt;
      const beat =
        m.beat != null
          ? Math.sin(Math.min(1, m.beat / 1.2) * Math.PI) * Math.exp(-m.beat * 1.6)
          : 0;
      m.pin.scale.setScalar(0.029 + 0.012 * beat);
      m.pin.material.opacity = show * Math.min(1, m.w * 1.4) * seen(m.at);
      if (!want && m.w < 0.01) {
        removeSprite(m.pin);
        marks.splice(i, 1);
      }
    }
    for (let i = 0; i < 4; i++) {
      const m = marks[marks.length - 1 - i];
      hotW[i] = m ? m.w * show : 0;
      if (m) hot[i].copy(m.at);
    }
  }

  function stepBlooms(dt: number) {
    for (let i = blooms.length - 1; i >= 0; i--) {
      const bloom = blooms[i];
      bloom.t += dt;
      if (bloom.t < 0) continue;
      const k = Math.min(1, bloom.t / 1.7);
      bloom.sprite.scale.setScalar(0.02 + bloom.size * (1 - (1 - k) ** 3));
      bloom.sprite.material.opacity =
        seen(bloom.sprite.position) *
        (bloom.soft ? 0.45 : 0.9) *
        (1 - k) ** (bloom.soft ? 1.6 : 1.2) *
        Math.min(1, bloom.t / 0.12);
      if (k >= 1) {
        removeSprite(bloom.sprite);
        blooms.splice(i, 1);
      }
    }
  }

  function update(dt: number) {
    t += dt;
    stepGlobe(dt);
    const show = ease((t - 0.8) / 1.2);
    schedule(dt);
    for (const flight of flights.slice()) stepFlight(flight, dt, show);
    stepMarks(dt, show);
    stepBlooms(dt);
    stepTags();
  }

  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    renderer.render(scene, camera);
    /* under reduced motion the scene settles and stops; a drag or a resize wakes it */
    const settled = reduced && t > SETTLED_AFTER && !drag;
    if (active && !settled) raf = requestAnimationFrame(frame);
  }
  function wake() {
    if (!active || raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  host.dataset.live = "true";

  return {
    setActive(next) {
      if (next === active) return;
      active = next;
      if (active) {
        window.addEventListener("scroll", readPlace, { passive: true });
        readPlace();
        wake();
      } else {
        window.removeEventListener("scroll", readPlace);
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    dispose() {
      active = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver.disconnect();
      window.removeEventListener("scroll", readPlace);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", letGo);
      canvas.removeEventListener("pointercancel", letGo);
      canvas.removeEventListener("pointerleave", letGo);
      for (const flight of flights.slice()) drop(flight);
      for (const m of marks.splice(0)) removeSprite(m.pin);
      for (const bloom of blooms.splice(0)) removeSprite(bloom.sprite);
      occluder.geometry.dispose();
      occluder.material.dispose();
      rim.geometry.dispose();
      rimMaterial.dispose();
      coastline.geometry.dispose();
      landMaterial.dispose();
      DISC.dispose();
      RING.dispose();
      HALO.dispose();
      mounted.unmount();
      delete host.dataset.live;
    },
  };
}
