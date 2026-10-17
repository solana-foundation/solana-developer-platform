/*
 * The coasts: the 50m Natural Earth coasts simplified, their straight runs kept to a 15 degree
 * grid, every corner rounded, the islands kept (Japan, insular Asia, the Mediterranean), so every city a
 * payment touches sits on land.
 */
import * as THREE from "three";
import { LAND } from "./land-data";

const DEG = THREE.MathUtils.DEG2RAD;

/** Tolerance and corner radius in degrees, the angle grid in degrees, line radius in scene units,
 * islands below this many square degrees left out, ink the strength of the grey. */
export const GLOBE_DRAWING = {
  tol: 0.55,
  snap: 15,
  corner: 1.5,
  width: 0.0032,
  islands: 2,
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

function segmentDistance(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const ab = b.clone().sub(a);
  const lengthSq = ab.lengthSq();
  if (lengthSq < 1e-12) return p.distanceTo(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lengthSq, 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/** Douglas-Peucker. */
function simplify(points: THREE.Vector3[], tolerance: number) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() as [number, number];
    let far = -1;
    let farDistance = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = segmentDistance(points[k], points[i], points[j]);
      if (d > farDistance) {
        farDistance = d;
        far = k;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
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

type Ring = (typeof LAND)[number];
type RingPoint = Ring[number];

function ringBounds(ring: Ring) {
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const [lon, lat] of ring) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

/* the cut along the 180th meridian is removed, so it never draws as a seam */
function splitAtAntimeridian(ring: Ring) {
  const pieces: RingPoint[][] = [];
  let piece = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];
    if (Math.abs(a[0]) > 179.5 && Math.abs(b[0]) > 179.5) {
      if (piece.length > 1) pieces.push(piece);
      piece = [b];
    } else piece.push(b);
  }
  if (piece.length > 1) pieces.push(piece);
  return pieces;
}

/* Every ring as polylines on the unit sphere: Antarctica left out, specks below the island
   threshold left out. */
function coasts(drawing: Drawing) {
  const lines: THREE.Vector3[][] = [];
  for (const ring of LAND) {
    const { minLat, maxLat, minLon, maxLon } = ringBounds(ring);
    if (minLat < -60) continue;
    const midCos = Math.cos(((minLat + maxLat) / 2) * DEG);
    if ((maxLon - minLon) * midCos * (maxLat - minLat) < drawing.islands) continue;

    const pieces = splitAtAntimeridian(ring);
    const closed = pieces.length === 1;
    /* a small island keeps its shape: its tolerance is never more than an eighth of the island,
       so it stays an island rather than a sliver */
    const tolerance = Math.min(
      drawing.tol,
      0.12 * Math.hypot((maxLon - minLon) * midCos, maxLat - minLat)
    );
    for (const part of pieces) {
      let points = part.map(([lon, lat]) => latLon(lat, lon, 1).normalize());
      if (closed) points.pop();
      points = simplify(closed ? points.concat([points[0]]) : points, tolerance * DEG);
      if (closed) points.pop();
      if (points.length < (closed ? 4 : 2)) continue;
      points = fillet(snapToGrid(points, closed, drawing.snap * DEG), closed, drawing.corner * DEG);
      if (closed) points.push(points[0].clone());
      lines.push(points);
    }
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
