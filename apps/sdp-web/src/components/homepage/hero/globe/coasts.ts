/*
 * The coasts: the 50m Natural Earth coasts simplified, their straight runs kept to a 15 degree
 * grid, every corner rounded, the islands kept (Japan, insular Asia, the Mediterranean), so every city a
 * payment touches sits on land.
 */
import * as THREE from "three";
import { LAND } from "./land-data";

const DEG = THREE.MathUtils.DEG2RAD;

/** The angle grid and corner radius in degrees, line radius in scene units, ink the strength of
 * the grey. The simplification and the island threshold are baked into land-data.ts. */
export const GLOBE_DRAWING = {
  snap: 15,
  corner: 1.5,
  width: 0.0032,
  ink: 1.2,
} as const;

type Drawing = typeof GLOBE_DRAWING;

/** A point on a sphere of radius `r` at a latitude and longitude. */
export function latLon(lat: number, lon: number, r: number) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

/* Directions are taken in the tangent plane, east along the parallel, so a run on the grid's 0
   reads as level on the screen when it faces the viewer. */
function tangentFrame(p: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const east = new THREE.Vector3(0, 1, 0).cross(p);
  if (east.lengthSq() < 1e-10) east.set(1, 0, 0);
  east.normalize();
  return [east, p.clone().cross(east).normalize()];
}

/* Turn every segment toward its nearest grid direction by moving the vertices, not by adding any:
   a few rounds in which each vertex goes where its two snapped neighbours would put it, held to
   where the coast really is by a light anchor. No new corners, so no staircase. */
function snapToGrid(points: THREE.Vector3[], closed: boolean, step: number) {
  if (!step || points.length < 3) return points;
  const count = points.length;
  const original = points.map((p) => p.clone());
  const segments = closed ? count : count - 1;
  let current = points.map((p) => p.clone());
  const snapped = (p: THREE.Vector3, q: THREE.Vector3) => {
    const mid = p.clone().add(q).normalize();
    const [east, north] = tangentFrame(mid);
    const d = q.clone().sub(p);
    const dx = d.dot(east);
    const dy = d.dot(north);
    const length = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return east
      .multiplyScalar(Math.cos(angle) * length)
      .addScaledVector(north, Math.sin(angle) * length);
  };
  for (let round = 0; round < 14; round++) {
    const vectors: THREE.Vector3[] = [];
    for (let i = 0; i < segments; i++) vectors.push(snapped(current[i], current[(i + 1) % count]));
    const next = current.map((p) => p.clone());
    for (let i = 0; i < count; i++) {
      if (!closed && (i === 0 || i === count - 1)) continue;
      const fromBefore = current[(i - 1 + count) % count]
        .clone()
        .add(vectors[(i - 1 + segments) % segments]);
      const fromAfter = current[(i + 1) % count].clone().sub(vectors[i % segments]);
      next[i] = original[i].clone().multiplyScalar(0.25).add(fromBefore).add(fromAfter).normalize();
    }
    current = next;
  }
  return current;
}

/** Rounds every corner with a fixed radius (a quadratic curve through it). */
function fillet(points: THREE.Vector3[], closed: boolean, radius: number) {
  const out: THREE.Vector3[] = [];
  const count = points.length;
  for (let i = 0; i < count; i++) {
    if (!closed && (i === 0 || i === count - 1)) {
      out.push(points[i]);
      continue;
    }
    const a = points[(i - 1 + count) % count];
    const b = points[i];
    const c = points[(i + 1) % count];
    const ab = a.distanceTo(b);
    const bc = b.distanceTo(c);
    const r = Math.min(radius, ab * 0.5, bc * 0.5);
    if (r < 1e-6) {
      out.push(b);
      continue;
    }
    const p1 = b.clone().lerp(a, r / ab);
    const p2 = b.clone().lerp(c, r / bc);
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const u = 1 - t;
      out.push(
        new THREE.Vector3()
          .addScaledVector(p1, u * u)
          .addScaledVector(b, 2 * u * t)
          .addScaledVector(p2, t * t)
          .normalize()
      );
    }
  }
  return out;
}

/* Every coast as a polyline on the unit sphere, snapped and rounded. */
function coasts(drawing: Drawing) {
  const lines: THREE.Vector3[][] = [];
  for (const { closed, points: coast } of LAND) {
    const points = fillet(
      snapToGrid(
        coast.map(([lon, lat]) => latLon(lat, lon, 1).normalize()),
        closed,
        drawing.snap * DEG
      ),
      closed,
      drawing.corner * DEG
    );
    if (closed) points.push(points[0].clone());
    lines.push(points);
  }
  return lines;
}

function mergeGeometries(parts: THREE.BufferGeometry[]) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    vertexCount += part.attributes.position.count;
    indexCount += part.index?.count ?? 0;
  }
  const position = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint32Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    position.set(part.attributes.position.array, vertexOffset * 3);
    uv.set(part.attributes.uv.array, vertexOffset * 2);
    const partIndex = part.index?.array ?? [];
    for (let i = 0; i < partIndex.length; i++) index[indexOffset + i] = partIndex[i] + vertexOffset;
    vertexOffset += part.attributes.position.count;
    indexOffset += partIndex.length;
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

/** Every coast as one tube mesh, sampled finely enough to keep the small corners. */
export function landGeometry(drawing: Drawing = GLOBE_DRAWING) {
  const STEP = 0.004;
  const parts: THREE.BufferGeometry[] = [];
  for (const line of coasts(drawing)) {
    const points: THREE.Vector3[] = [];
    line.forEach((v, i) => {
      if (i) {
        const previous = points[points.length - 1];
        const n = Math.ceil(previous.distanceTo(v) / STEP);
        for (let k = 1; k < n; k++)
          points.push(
            previous
              .clone()
              .lerp(v, k / n)
              .normalize()
          );
      }
      points.push(v.clone());
    });
    if (points.length < 4) continue;
    for (const v of points) v.multiplyScalar(1.004);
    parts.push(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points, false, "centripetal", 0),
        points.length,
        drawing.width,
        5,
        false
      )
    );
  }
  return mergeGeometries(parts);
}
