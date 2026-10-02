import * as THREE from "three";

type Stop = readonly [offset: number, color: string];
/** A soft highlight added over the sphere: position (0..1) and colour. */
type Rim = readonly [x: number, y: number, radius: number, color: string];

/**
 * A matcap painted once on a canvas: a sphere lit from the upper left, with
 * optional coloured rims. Every object on the page is made of one of these,
 * so the material is the brand.
 */
function paintMatcap(stops: readonly Stop[], rims: readonly Rim[]): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const sphere = () => {
      context.beginPath();
      context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      context.fill();
    };
    const base = context.createRadialGradient(
      size * 0.38,
      size * 0.34,
      size * 0.04,
      size * 0.5,
      size * 0.5,
      size * 0.52
    );
    for (const [offset, color] of stops) base.addColorStop(offset, color);
    context.fillStyle = base;
    sphere();
    context.globalCompositeOperation = "lighter";
    for (const [x, y, radius, color] of rims) {
      const rim = context.createRadialGradient(
        size * x,
        size * y,
        size * 0.02,
        size * x,
        size * y,
        size * radius
      );
      rim.addColorStop(0, color);
      rim.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = rim;
      sphere();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const GREEN_RIM: Rim = [0.74, 0.8, 0.36, "rgba(20,241,149,0.25)"];
const PURPLE_RIM: Rim = [0.74, 0.8, 0.36, "rgba(153,69,255,0.22)"];

/** The brand purple: the state an object passes through while it forms. */
export function glowMatcap(): THREE.Texture {
  return paintMatcap(
    [
      [0, "#f3e9ff"],
      [0.18, "#c9a6ff"],
      [0.5, "#9945ff"],
      [0.86, "#4a2880"],
      [1, "#261441"],
    ],
    [GREEN_RIM]
  );
}

/**
 * The finished state. On paper it is ink, as the design draws it; on the dark
 * theme ink would vanish into the ground, so it is a light silver there.
 */
export function finishMatcap(ground: "paper" | "dark"): THREE.Texture {
  if (ground === "dark") {
    return paintMatcap(
      [
        [0, "#ffffff"],
        [0.25, "#dddbe4"],
        [0.6, "#8c8895"],
        [1, "#3a3842"],
      ],
      [PURPLE_RIM]
    );
  }
  return paintMatcap(
    [
      [0, "#5a5866"],
      [0.2, "#34323d"],
      [0.55, "#16151b"],
      [1, "#08080a"],
    ],
    [PURPLE_RIM]
  );
}

/** The dashed outline each part is drawn as before it has a surface. */
export function outlineColor(ground: "paper" | "dark"): number {
  return ground === "dark" ? 0xfcfcfa : 0x0f0f13;
}
