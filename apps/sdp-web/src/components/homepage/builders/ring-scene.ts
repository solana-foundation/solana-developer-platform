/*
 * Meet the builders: one shot, scrubbed by the scroll (after the Codrops "cinematic scroll"
 * demo). A cylinder of the sixteen stills, two rows of eight; a camera that starts outside it,
 * rises to look down into it, dives in, lingers among the tiles and pulls back out, while the
 * ring turns. Light streaks show on the rim while it turns. The ring also turns slowly on its
 * own, so the shot is alive when the page is still.
 *
 * The only module that imports three.js; it is fetched when the section nears the screen.
 */
import * as THREE from "three";
import { mountRenderer } from "@/lib/webgl";
import { FILMS, filmStill, filmUrl } from "./films";
import { createRimStreaks } from "./rim-streaks";
import { cameraAt, cameraDistance, captionOpacity } from "./ring-scene-math";

export type RingScene = {
  setActive: (active: boolean) => void;
  dispose: () => void;
};

type RingSceneOptions = {
  /** The scroll room: how far the page has moved through it is the shot's progress. */
  section: HTMLElement;
  /** The pinned stage; the scene's canvas goes in as its first child and fills it. */
  stage: HTMLElement;
  canvasClassName?: string;
  /** The caption boxes, in order; their opacity follows the shot. */
  captions: HTMLElement[];
  /** Turns of the ring over the whole shot. */
  turns: number;
  onCaption: (index: number, shown: boolean) => void;
  onLost: () => void;
};

const PER = 8;
const ROWS = 2;
const R = 2.5;
const TILE_W = (2 * Math.PI * R) / PER;
const TILE_H = (TILE_W * 9) / 16;
const GAP = 0.06;
/* how quickly the shot follows the scroll, per second: the reference's 4.5% of the way a frame */
const FOLLOW = -Math.log(1 - 0.045) * 60;

/** Builds the scene, or returns null when WebGL cannot start, so the section shows its list. */
export function createRingScene({
  section,
  stage,
  canvasClassName,
  captions,
  turns,
  onCaption,
  onLost,
}: RingSceneOptions): RingScene | null {
  const mounted = mountRenderer(
    () => new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "default" }),
    stage,
    { className: canvasClassName, onLost }
  );
  if (!mounted) return null;
  const { renderer, canvas } = mounted;
  renderer.setClearColor(0x08080a, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);

  /* one strip per row, eight stills side by side, as sharp as the GPU allows */
  const stillW = Math.min(1024, Math.floor(renderer.capabilities.maxTextureSize / PER / 64) * 64);
  const stillH = (stillW * 9) / 16;
  const images: HTMLImageElement[] = [];
  const textures: THREE.Texture[] = [];
  let disposed = false;

  function strip(row: number): [THREE.CanvasTexture, THREE.CanvasTexture] {
    const board = document.createElement("canvas");
    board.width = stillW * PER;
    board.height = stillH;
    const context = board.getContext("2d");
    if (context) {
      context.fillStyle = "#141219";
      context.fillRect(0, 0, board.width, board.height);
    }
    const outside = new THREE.CanvasTexture(board);
    outside.colorSpace = THREE.SRGBColorSpace;
    outside.anisotropy = 8;
    outside.wrapS = THREE.RepeatWrapping;
    /* the inner face sees the strip from behind: mirrored, so the stills read the right way */
    const inside = outside.clone();
    inside.repeat.x = -1;
    inside.offset.x = 1;
    textures.push(outside, inside);
    if (!context) return [outside, inside];

    /* the row's eight stills decode first, then go up to the GPU together, once */
    const stills = FILMS.slice(row * PER, row * PER + PER).map((film) => {
      const image = new Image();
      image.src = filmStill(film.id);
      images.push(image);
      return image;
    });
    void Promise.allSettled(stills.map((image) => image.decode())).then((decoded) => {
      if (disposed) return;
      stills.forEach((image, i) => {
        if (decoded[i]?.status !== "fulfilled") return;
        context.drawImage(image, i * stillW, 0, stillW, stillH);
        /* a hairline between stills, so the ring reads as tiles */
        context.fillStyle = "rgba(8,8,10,0.9)";
        context.fillRect(i * stillW, 0, 2, stillH);
      });
      outside.needsUpdate = true;
      inside.needsUpdate = true;
    });
    return [outside, inside];
  }

  /* the reference's 0.3 darkening */
  const shade = 0xb3b3b3;
  const geometry = new THREE.CylinderGeometry(R, R, TILE_H, 64, 1, true);
  const materials: THREE.Material[] = [];
  const ring = new THREE.Group();
  ring.rotation.y = 0.5;
  scene.add(ring);
  const faces: THREE.Mesh[] = [];
  /* each face's row, and whether it is the inner (mirrored) one, for the click */
  const faceRows = new Map<THREE.Object3D, { row: number; inner: boolean }>();
  for (let row = 0; row < ROWS; row++) {
    const [outside, inside] = strip(row);
    const group = new THREE.Group();
    group.position.y = (row - (ROWS - 1) / 2) * (TILE_H + GAP);
    /* the second row offset by half a tile */
    group.rotation.y = row % 2 ? Math.PI / PER : 0;
    const outerMaterial = new THREE.MeshBasicMaterial({
      map: outside,
      color: shade,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    const innerMaterial = new THREE.MeshBasicMaterial({
      map: inside,
      color: shade,
      side: THREE.BackSide,
      toneMapped: false,
    });
    materials.push(outerMaterial, innerMaterial);
    const outer = new THREE.Mesh(geometry, outerMaterial);
    const inner = new THREE.Mesh(geometry, innerMaterial);
    faceRows.set(outer, { row, inner: false });
    faceRows.set(inner, { row, inner: true });
    group.add(outer, inner);
    ring.add(group);
    faces.push(outer, inner);
  }

  /* the streaks on the rim, out past the ring's edge */
  const streaks = createRimStreaks(scene, R + 0.8, (TILE_H + GAP) * ROWS);

  /* a click on a still opens its film; keyboard users have the links */
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let down: [number, number] | null = null;
  function filmAt(clientX: number, clientY: number) {
    const box = canvas.getBoundingClientRect();
    pointer.set(
      ((clientX - box.left) / box.width) * 2 - 1,
      -((clientY - box.top) / box.height) * 2 + 1
    );
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(faces, false)[0];
    const face = hit && faceRows.get(hit.object);
    if (!hit?.uv || !face) return null;
    const u = face.inner ? 1 - hit.uv.x : hit.uv.x;
    return FILMS[face.row * PER + Math.min(PER - 1, Math.floor(u * PER))] ?? null;
  }
  const onPointerMove = (event: PointerEvent) => {
    canvas.style.cursor = filmAt(event.clientX, event.clientY) ? "pointer" : "";
  };
  const onPointerDown = (event: PointerEvent) => {
    down = [event.clientX, event.clientY];
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = down;
    down = null;
    if (!start || Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 6) return;
    const film = filmAt(event.clientX, event.clientY);
    if (film) window.open(filmUrl(film.id), "_blank", "noopener,noreferrer");
  };
  canvas.addEventListener("pointermove", onPointerMove, { passive: true });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);

  let width = 0;
  let height = 0;
  let cz = cameraDistance(window.innerWidth);
  function resize() {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    cz = cameraDistance(window.innerWidth);
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  /* the stage spans the window, so a change of the window's width (and so of `cz`) resizes it */
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  let target = 0;
  function readScroll() {
    const box = section.getBoundingClientRect();
    const total = box.height - window.innerHeight;
    target = total > 0 ? THREE.MathUtils.clamp(-box.top / total, 0, 1) : 1;
  }
  readScroll();

  const turn = turns * Math.PI * 2;
  const shown = captions.map(() => false);
  let p = target;
  let spin = 0;
  let lastScrollRotation = 0.5 + turn * p;
  let last = performance.now();
  let active = false;
  let raf = 0;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(100, now - last);
    last = now;
    /* a soft follow of the scroll that does not depend on the frame rate, plus the idle turn */
    p = THREE.MathUtils.damp(p, target, FOLLOW, dt / 1000);
    if (Math.abs(target - p) < 0.0004) p = target;
    spin += dt * 0.00009;

    const shot = cameraAt(p, cz);
    camera.position.set(shot.position[0], shot.position[1], shot.position[2]);
    camera.lookAt(0, shot.look, 0);
    const scrollRotation = 0.5 + turn * p;
    ring.rotation.y = scrollRotation + spin;

    /* the streaks show while the scroll turns the ring, not for the idle turn */
    const velocity = scrollRotation - lastScrollRotation;
    lastScrollRotation = scrollRotation;
    streaks.update(velocity, dt / 1000);

    captions.forEach((caption, index) => {
      const opacity = captionOpacity(p, index, captions.length);
      caption.style.opacity = opacity.toFixed(3);
      const on = opacity > 0.02;
      if (on !== shown[index]) {
        shown[index] = on;
        onCaption(index, on);
      }
    });

    renderer.render(scene, camera);
  }

  return {
    setActive(next) {
      if (next === active) return;
      active = next;
      if (active) {
        /* the scroll is read only while the ring draws */
        window.addEventListener("scroll", readScroll, { passive: true });
        readScroll();
        last = performance.now();
        raf = requestAnimationFrame(frame);
      } else {
        window.removeEventListener("scroll", readScroll);
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    dispose() {
      active = false;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver.disconnect();
      window.removeEventListener("scroll", readScroll);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.style.cursor = "";
      for (const caption of captions) caption.style.opacity = "";
      for (const image of images) image.removeAttribute("src");
      for (const texture of textures) texture.dispose();
      for (const material of materials) material.dispose();
      geometry.dispose();
      streaks.dispose();
      mounted.unmount();
    },
  };
}
