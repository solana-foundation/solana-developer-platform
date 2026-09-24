import * as THREE from "three";

const DEG = Math.PI / 180;

export type CityKey =
  | "fra"
  | "sin"
  | "lon"
  | "iad"
  | "sfo"
  | "tyo"
  | "ams"
  | "gru"
  | "syd"
  | "dxb"
  | "nyc"
  | "lag"
  | "bom"
  | "jnb"
  | "mex"
  | "hkg";

/** [latitude, longitude]. Display names are resolved by the caller so they can be translated. */
export const CITIES: Record<CityKey, readonly [number, number]> = {
  fra: [50.1, 8.7],
  sin: [1.3, 103.8],
  lon: [51.5, -0.1],
  iad: [38.9, -77.4],
  sfo: [37.6, -122.4],
  tyo: [35.7, 139.7],
  ams: [52.3, 4.8],
  gru: [-23.4, -46.5],
  syd: [-33.9, 151.2],
  dxb: [25.3, 55.4],
  nyc: [40.7, -74.0],
  lag: [6.5, 3.4],
  bom: [19.1, 72.9],
  jnb: [-26.2, 28.0],
  mex: [19.4, -99.1],
  hkg: [22.3, 114.2],
};

export const CITY_KEYS = Object.keys(CITIES) as CityKey[];

/** A point on a sphere of radius `r` for a latitude/longitude in degrees. */
export function latLonToVector(lat: number, lon: number, r: number): THREE.Vector3 {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

/** Hairlines every fifteen degrees, as line-segment pairs. */
export function graticulePoints(r: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let lat = -75; lat <= 75; lat += 15) {
    for (let lon = -180; lon < 180; lon += 3) {
      points.push(latLonToVector(lat, lon, r), latLonToVector(lat, lon + 3, r));
    }
  }
  for (let lon = -180; lon < 180; lon += 15) {
    for (let lat = -90; lat < 90; lat += 3) {
      points.push(latLonToVector(lat, lon, r), latLonToVector(lat + 3, lon, r));
    }
  }
  return points;
}

const GRID_STEP = 15;
const snapToGrid = (value: number) => Math.round(value / GRID_STEP) * GRID_STEP;

/**
 * A payment route that runs along the graticule: out to the nearest grid
 * crossing, two turns through a randomised midpoint, and in to the destination.
 */
export function routePoints(
  from: readonly [number, number],
  to: readonly [number, number],
  r: number
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const push = (lat: number, lon: number) => points.push(latLonToVector(lat, lon, r));
  const along = (lat0: number, lon0: number, lat1: number, lon1: number) => {
    const steps = Math.max(
      2,
      Math.ceil(Math.max(Math.abs(lat1 - lat0), Math.abs(lon1 - lon0)) / 2)
    );
    for (let i = 1; i <= steps; i++) {
      push(lat0 + ((lat1 - lat0) * i) / steps, lon0 + ((lon1 - lon0) * i) / steps);
    }
  };

  let deltaLon = to[1] - from[1];
  if (deltaLon > 180) deltaLon -= 360;
  if (deltaLon < -180) deltaLon += 360;
  const toLon = from[1] + deltaLon;

  const start = [snapToGrid(from[0]), snapToGrid(from[1])] as const;
  const end = [snapToGrid(to[0]), snapToGrid(toLon)] as const;
  const midLon =
    start[1] +
    Math.round(((end[1] - start[1]) * (0.35 + Math.random() * 0.3)) / GRID_STEP) * GRID_STEP;
  const midLat = Math.max(
    -75,
    Math.min(
      75,
      start[0] +
        Math.round(((end[0] - start[0]) * (0.4 + Math.random() * 0.3)) / GRID_STEP) * GRID_STEP
    )
  );

  push(from[0], from[1]);
  along(from[0], from[1], start[0], start[1]);
  along(start[0], start[1], start[0], midLon);
  along(start[0], midLon, midLat, midLon);
  along(midLat, midLon, midLat, end[1]);
  along(midLat, end[1], end[0], end[1]);
  along(end[0], end[1], to[0], toLon);
  return points;
}

export function pathThrough(points: THREE.Vector3[]): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < points.length - 1; i++) {
    path.add(new THREE.LineCurve3(points[i], points[i + 1]));
  }
  return path;
}
