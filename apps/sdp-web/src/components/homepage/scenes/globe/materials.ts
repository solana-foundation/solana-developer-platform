import * as THREE from "three";

export type GlobePalette = {
  ground: string;
  grid: string;
  gridAlpha: readonly [back: number, front: number];
  silver: readonly [highlight: string, mid: string, shadow: string];
  ink: string;
  pink: string;
  green: string;
};

/**
 * One palette per theme. `ground` must equal the page background behind the
 * canvas (`--hp-paper` in that theme): the far side of the planet is hidden
 * by a sphere painted in it.
 */
export const GLOBE_PALETTES = {
  paper: {
    ground: "#fcfcfa",
    grid: "#1c1c1d",
    gridAlpha: [0.04, 0.14],
    silver: ["#ffffff", "#b9b5c3", "#5e5a68"],
    ink: "#1c1c1d",
    pink: "#dc1fff",
    green: "#14f195",
  },
  dark: {
    ground: "#1c1c1d",
    grid: "#3a3842",
    gridAlpha: [0.1, 0.5],
    silver: ["#dddbe4", "#8c8895", "#3a3842"],
    ink: "#fcfcfa",
    pink: "#dc1fff",
    green: "#14f195",
  },
} as const satisfies Record<string, GlobePalette>;

export type GlobeGround = keyof typeof GLOBE_PALETTES;

function canvasTexture(size: number, paint: (context: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) paint(context);
  return new THREE.CanvasTexture(canvas);
}

/** Light on metal, painted once: a bright shoulder top-left, a dark turn bottom-right, a violet breath. */
export function silverMatcap(colors: GlobePalette["silver"]): THREE.Texture {
  const texture = canvasTexture(256, (context) => {
    let gradient = context.createRadialGradient(96, 88, 10, 128, 128, 132);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(0.45, colors[1]);
    gradient.addColorStop(1, colors[2]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);

    gradient = context.createRadialGradient(180, 176, 4, 180, 176, 90);
    gradient.addColorStop(0, "rgba(153,69,255,.22)");
    gradient.addColorStop(1, "rgba(153,69,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);

    gradient = context.createRadialGradient(80, 72, 2, 80, 72, 48);
    gradient.addColorStop(0, "rgba(255,255,255,.85)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft round glow for sprites; `color` is a #rrggbb hex. */
export function glowTexture(color: string): THREE.Texture {
  return canvasTexture(64, (context) => {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, `${color}ff`);
    gradient.addColorStop(0.35, `${color}99`);
    gradient.addColorStop(1, `${color}00`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  });
}

/** Graticule hairlines that fade toward the rim; `uReveal` fades the whole grid in. */
export function gridMaterial(palette: GlobePalette, reveal: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(palette.grid) },
      uBack: { value: palette.gridAlpha[0] },
      uFront: { value: palette.gridAlpha[1] },
      uReveal: { value: reveal },
    },
    vertexShader: `varying float vFacing;
      void main() {
        vec3 n = normalize(normalMatrix * normalize(position));
        vFacing = n.z;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform vec3 uColor; uniform float uBack; uniform float uFront; uniform float uReveal;
      varying float vFacing;
      void main() {
        float a = mix(uBack, uFront, smoothstep(0.0, 0.6, vFacing)) * uReveal;
        if (a < 0.008) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
}

const BEAM_VERTEX = `varying float vU; varying float vEdge;
  void main() {
    vU = uv.x;
    vec3 n = normalize(normalMatrix * normal);
    vEdge = abs(n.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const BEAM_CORE_FRAGMENT = `uniform vec3 uColor; uniform float uProgress; uniform float uOpacity;
  varying float vU; varying float vEdge;
  void main() {
    if (vU > uProgress) discard;
    float tail = mix(0.5, 1.0, smoothstep(uProgress - 0.6, uProgress, vU));
    float glow = mix(1.0, 1.3, smoothstep(uProgress - 0.08, uProgress, vU));
    gl_FragColor = vec4(uColor * glow, uOpacity * tail);
  }`;

const BEAM_HALO_FRAGMENT = `uniform vec3 uColor; uniform float uProgress; uniform float uOpacity;
  varying float vU; varying float vEdge;
  void main() {
    if (vU > uProgress) discard;
    float tail = smoothstep(uProgress - 0.35, uProgress, vU);
    float soft = pow(vEdge, 2.2);
    gl_FragColor = vec4(uColor, uOpacity * tail * soft);
  }`;

/** A travelling beam: `core` is the hairline, `halo` the soft glow trailing the head. */
export function beamMaterial(
  kind: "core" | "halo",
  color: THREE.Color,
  opacity: number
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: color.clone() },
      uProgress: { value: 0 },
      uOpacity: { value: opacity },
    },
    vertexShader: BEAM_VERTEX,
    fragmentShader: kind === "core" ? BEAM_CORE_FRAGMENT : BEAM_HALO_FRAGMENT,
  });
}
