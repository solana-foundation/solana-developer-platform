import * as THREE from "three";
import { FILMS } from "./films";

export const PER_ROW = 8;
const ROWS = 2;
export const RADIUS = 2.5;
/** 16:9 tiles, edge to edge around the ring. */
const TILE_HEIGHT = (((2 * Math.PI * RADIUS) / PER_ROW) * 9) / 16;
const GAP = 0.06;
/** The reference darkens the stills by 0.3, so the captions read over them. */
const DIMMED = 0xb3b3b3;

/**
 * One texture per row: eight stills side by side, painted as they load. The
 * inner face gets a mirrored copy so the stills read the right way round
 * from inside the ring too.
 */
function rowTextures(row: number, tileWidth: number) {
  const tileHeight = (tileWidth * 9) / 16;
  const canvas = document.createElement("canvas");
  canvas.width = tileWidth * PER_ROW;
  canvas.height = tileHeight;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#141219";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const outer = new THREE.CanvasTexture(canvas);
  outer.colorSpace = THREE.SRGBColorSpace;
  outer.anisotropy = 8;
  outer.wrapS = THREE.RepeatWrapping;
  const inner = outer.clone();
  inner.repeat.x = -1;
  inner.offset.x = 1;

  const images: HTMLImageElement[] = [];
  for (let i = 0; i < PER_ROW; i++) {
    const image = new Image();
    image.onload = () => {
      if (!context) return;
      context.drawImage(image, i * tileWidth, 0, tileWidth, tileHeight);
      // A hairline between stills, so the ring reads as tiles.
      context.fillStyle = "rgba(8,8,10,0.9)";
      context.fillRect(i * tileWidth, 0, 2, tileHeight);
      outer.needsUpdate = true;
      inner.needsUpdate = true;
    };
    image.src = `/homepage/builders/${FILMS[row * PER_ROW + i][0]}.jpg`;
    images.push(image);
  }
  return { outer, inner, images };
}

/** The ring of stills (two rows of eight) and the light streaks on its rim. */
export function buildRing(maxTextureSize: number) {
  // As sharp as the GPU allows: eight stills across one texture.
  const tileWidth = Math.min(1024, Math.floor(maxTextureSize / PER_ROW / 64) * 64);
  const geometry = new THREE.CylinderGeometry(RADIUS, RADIUS, TILE_HEIGHT, 64, 1, true);
  const group = new THREE.Group();
  group.rotation.y = 0.5;
  const faces: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = [];
  const disposables: { dispose: () => void }[] = [geometry];
  const images: HTMLImageElement[] = [];

  for (let row = 0; row < ROWS; row++) {
    const textures = rowTextures(row, tileWidth);
    images.push(...textures.images);
    const rowGroup = new THREE.Group();
    rowGroup.position.y = (row - (ROWS - 1) / 2) * (TILE_HEIGHT + GAP);
    // The second row sits half a tile round from the first.
    rowGroup.rotation.y = row % 2 ? Math.PI / PER_ROW : 0;
    for (const [texture, side] of [
      [textures.outer, THREE.FrontSide],
      [textures.inner, THREE.BackSide],
    ] as const) {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        color: DIMMED,
        side,
        toneMapped: false,
      });
      const face = new THREE.Mesh(geometry, material);
      face.userData.row = row;
      rowGroup.add(face);
      faces.push(face);
      disposables.push(material, texture);
    }
    group.add(rowGroup);
  }

  const streaks = buildStreaks((TILE_HEIGHT + GAP) * ROWS);
  disposables.push(...streaks.disposables);

  return {
    group,
    faces,
    streaks,
    dispose: () => {
      for (const image of images) image.onload = null;
      for (const item of disposables) item.dispose();
    },
  };
}

const STREAK_SEGMENTS = 20;
const STREAK_RADIUS = RADIUS + 0.8;

/** Twelve arcs of light just outside the rim; they show while the ring turns. */
function buildStreaks(span: number) {
  const lines: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  const disposables: { dispose: () => void }[] = [];
  for (let i = 0; i < 12; i++) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array((STREAK_SEGMENTS + 1) * 3), 3)
    );
    const material = new THREE.LineBasicMaterial({
      color: 0xb478ff,
      transparent: true,
      opacity: 0,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.userData = {
      base: (i / 12) * Math.PI * 2 + Math.random() * 0.4,
      y: (Math.random() - 0.5) * span * 1.3,
      speed: 0.6 + Math.random() * 0.8,
    };
    lines.push(line);
    disposables.push(geometry, material);
    lay(line);
  }

  function lay(line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>) {
    const { base, y } = line.userData as { base: number; y: number };
    const positions = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let j = 0; j <= STREAK_SEGMENTS; j++) {
      const angle = base + 0.3 * (j / STREAK_SEGMENTS);
      positions.setXYZ(j, Math.cos(angle) * STREAK_RADIUS, y, Math.sin(angle) * STREAK_RADIUS);
    }
    positions.needsUpdate = true;
  }

  /** Fades the streaks toward how fast the ring turns, and carries them round with it. */
  const step = (turn: number) => {
    const speed = Math.abs(turn) * 100;
    const turning = Math.abs(turn) > 0.0001;
    for (const line of lines) {
      const want = turning ? Math.min(speed * 3, 0.95) : 0;
      line.material.opacity += (want - line.material.opacity) * 0.15;
      if (turning) {
        line.userData.base += turn * line.userData.speed * 1.5;
        lay(line);
      }
    }
  };

  return { lines, step, disposables };
}
