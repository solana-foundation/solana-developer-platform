/*
 * Builds the hero globe's coasts, src/components/homepage/hero/globe/land-data.ts, from the 50m
 * land of world-atlas (Natural Earth, public domain). `--check` fails when the committed file
 * differs from what this script writes.
 *
 * The globe reads the result as it is: coasts.ts only snaps and rounds the lines, so the
 * simplification below decides which points the globe has at all.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { feature } from "topojson-client/dist/topojson-client.js";
import world from "world-atlas/land-50m.json" with { type: "json" };

const webDirectory = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(webDirectory, "../..");
const outputPath = path.join(webDirectory, "src/components/homepage/hero/globe/land-data.ts");

/* First pass, in plain degrees: Douglas-Peucker tolerance, then two decimals. */
const FIRST_TOLERANCE = 0.08;
/* Second pass, on the sphere: tolerance in degrees, never more than this share of the island's
   diagonal, so a small island stays an island rather than a sliver. */
const TOLERANCE = 0.55;
const SMALL_ISLAND_TOLERANCE = 0.12;
/* Islands below this many square degrees and land reaching below this latitude are left out. */
const ISLANDS = 2;
const SOUTH = -60;

const DEG = THREE.MathUtils.DEG2RAD;
const round = (value) => Math.round(value * 100) / 100;

function perimeter(ring) {
  let length = 0;
  for (let i = 1; i < ring.length; i++)
    length += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  return length;
}

/* Douglas-Peucker over `count` points, `distance(k, i, j)` from point k to the line through i
   and j. Returns which points to keep. */
function simplify(count, distance, tolerance) {
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack = [[0, count - 1]];
  for (let span = stack.pop(); span; span = stack.pop()) {
    const [i, j] = span;
    let far = -1;
    let farDistance = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = distance(k, i, j);
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
  return keep;
}

/* distance from p to the infinite line through a and b, in degrees */
function lineDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (!length) return Math.hypot(px - ax, py - ay);
  return Math.abs(dx * (ay - py) - dy * (ax - px)) / length;
}

/* distance from p to the segment ab, on the unit sphere */
function segmentDistance(p, a, b) {
  const ab = b.clone().sub(a);
  const lengthSq = ab.lengthSq();
  if (lengthSq < 1e-12) return p.distanceTo(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lengthSq, 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/* as coasts.ts places a point */
function latLon(lat, lon) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  ).normalize();
}

/* the cut along the 180th meridian is removed, so it never draws as a seam */
function splitAtAntimeridian(ring) {
  const pieces = [];
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

/* Every outer ring (the Caspian's hole is not a coast), longest first, in two decimals. */
function rings() {
  const land = feature(world, world.objects.land);
  const outer = land.features.flatMap(({ geometry }) =>
    (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates).map(
      (polygon) => polygon[0]
    )
  );
  return outer
    .map((ring) => ({ ring, length: perimeter(ring) }))
    .sort(
      (a, b) => b.length - a.length || a.ring[0][0] - b.ring[0][0] || a.ring[0][1] - b.ring[0][1]
    )
    .map(({ ring }) => {
      const keep = simplify(
        ring.length,
        (k, i, j) => lineDistance(ring[k], ring[i], ring[j]),
        FIRST_TOLERANCE
      );
      return ring.filter((_, k) => keep[k]).map(([lon, lat]) => [round(lon), round(lat)]);
    });
}

/* The globe's lines: Antarctica and the specks below the island threshold left out, each ring
   cut at the 180th meridian and simplified on the sphere. A closed line does not repeat its first
   point. */
function coasts() {
  const lines = [];
  for (const ring of rings()) {
    const lons = ring.map(([lon]) => lon);
    const lats = ring.map(([, lat]) => lat);
    const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];
    const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
    if (minLat < SOUTH) continue;
    const midCos = Math.cos(((minLat + maxLat) / 2) * DEG);
    if ((maxLon - minLon) * midCos * (maxLat - minLat) < ISLANDS) continue;

    const pieces = splitAtAntimeridian(ring);
    const closed = pieces.length === 1;
    const tolerance = Math.min(
      TOLERANCE,
      SMALL_ISLAND_TOLERANCE * Math.hypot((maxLon - minLon) * midCos, maxLat - minLat)
    );
    /* a whole ring ends on its first point, so it simplifies as a loop */
    for (const coast of pieces) {
      const sphere = coast.map(([lon, lat]) => latLon(lat, lon));
      const keep = simplify(
        sphere.length,
        (k, i, j) => segmentDistance(sphere[k], sphere[i], sphere[j]),
        tolerance * DEG
      );
      const points = coast.filter((_, k) => keep[k]);
      if (closed) points.pop();
      if (points.length < (closed ? 4 : 2)) continue;
      lines.push({ closed, points });
    }
  }
  return lines;
}

function source(lines) {
  return `// AUTO-GENERATED - do not edit by hand.
// Regenerate: pnpm --filter sdp-web generate:globe-land (scripts/generate-globe-land.mjs)
/*
 * The land, as the globe draws it: the 50m land of world-atlas (Natural Earth, public domain),
 * without Antarctica or the smallest islands, simplified on the sphere. [lon, lat] pairs.
 * It is imported only by the globe scene and the still globe, which load lazily on the client.
 */
export type LandLine = {
  /** a whole ring, its last point joined to its first, or a piece of one cut at the 180th meridian */
  closed: boolean;
  points: readonly (readonly [lon: number, lat: number])[];
};

export const LAND: readonly LandLine[] = ${JSON.stringify(lines)};
`;
}

function format(text) {
  return execFileSync(
    "pnpm",
    ["--dir", repositoryRoot, "exec", "biome", "format", `--stdin-file-path=${outputPath}`],
    { input: text, encoding: "utf8" }
  );
}

const expected = format(source(coasts()));
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== expected) {
    process.stderr.write(
      "Globe land data is stale or hand-edited. Run: pnpm --filter sdp-web generate:globe-land\n"
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`Globe land data generated at ${outputPath}\n`);
}
