/*
 * The still globe, for a browser without WebGL: the same planet at the same angle, its coasts
 * drawn once on a 2D canvas (its rim is drawn in CSS, hero-globe.module.css). It loads the coast
 * data on demand but not three.js.
 */
import { LAND } from "./land-data";

const DEG = Math.PI / 180;
/* the WebGL scene's resting angle and camera (scene.ts) */
const TILT = 0.3;
const TURN = -1.25;
const CAMERA_Y = 0.06;
const CAMERA_DISTANCE = 3.95;
const FOCAL = 1 / Math.tan(15 * DEG);

type Projected = { x: number; y: number; facing: number };

type View = { scale: number; cx: number; cy: number; distance: number };

function project(lon: number, lat: number, { scale, cx, cy, distance }: View): Projected {
  /* a point on the unit sphere, as scene.ts places it */
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  let x = -Math.sin(phi) * Math.cos(theta);
  let y = Math.cos(phi);
  let z = Math.sin(phi) * Math.sin(theta);
  /* turned about y, then tilted about x (three's XYZ Euler order) */
  const x1 = x * Math.cos(TURN) + z * Math.sin(TURN);
  const z1 = -x * Math.sin(TURN) + z * Math.cos(TURN);
  x = x1;
  z = z1;
  const y2 = y * Math.cos(TILT) - z * Math.sin(TILT);
  const z2 = y * Math.sin(TILT) + z * Math.cos(TILT);
  y = y2;
  z = z2;
  const depth = distance - z;
  return {
    x: cx + ((x * FOCAL) / depth) * scale,
    y: cy - (((y - CAMERA_Y) * FOCAL) / depth) * scale,
    facing: z,
  };
}

/** Draws the planet into `canvas` at its current CSS size. Returns false without a 2D context. */
export function drawStaticGlobe(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return false;
  const ratio = Math.min(window.devicePixelRatio, 2);
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  /* framed as the perspective camera frames it: its field of view is vertical, and it steps
     back on a tall box */
  const view: View = {
    scale: height / 2,
    cx: width / 2,
    cy: height / 2,
    distance: CAMERA_DISTANCE * (width >= height ? 1 : Math.min(1.3, height / width)),
  };

  /* the coasts on the near side, fading toward the edge as the WebGL lines do */
  context.lineWidth = 1.4;
  context.lineJoin = "round";
  context.strokeStyle = "#CFCDCC";
  for (const ring of LAND) {
    let previous: Projected | null = null;
    for (const [lon, lat] of ring) {
      if (lat < -60) {
        previous = null;
        continue;
      }
      const point = project(lon, lat, view);
      if (previous && Math.abs(lon) < 179.5) {
        const facing = Math.min(previous.facing, point.facing);
        if (facing > 0) {
          context.globalAlpha = Math.min(1, facing / 0.42);
          context.beginPath();
          context.moveTo(previous.x, previous.y);
          context.lineTo(point.x, point.y);
          context.stroke();
        }
      }
      previous = point;
    }
  }
  context.globalAlpha = 1;
  return true;
}
