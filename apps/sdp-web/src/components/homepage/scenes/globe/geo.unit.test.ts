import { describe, expect, it } from "vitest";
import { CITIES, graticulePoints, latLonToVector, routePoints } from "./geo";

describe("globe geometry", () => {
  it("places points on the sphere's surface", () => {
    for (const [lat, lon] of Object.values(CITIES)) {
      expect(latLonToVector(lat, lon, 1.5).length()).toBeCloseTo(1.5, 6);
    }
  });

  it("puts the poles on the vertical axis", () => {
    const north = latLonToVector(90, 0, 1);

    expect(north.y).toBeCloseTo(1, 6);
    expect(Math.hypot(north.x, north.z)).toBeCloseTo(0, 6);
  });

  it("draws the graticule as line-segment pairs", () => {
    expect(graticulePoints(1).length % 2).toBe(0);
  });

  it("routes a payment from its origin city to its destination city", () => {
    const route = routePoints(CITIES.lon, CITIES.tyo, 1.014);

    expect(route[0].distanceTo(latLonToVector(...CITIES.lon, 1.014))).toBeCloseTo(0, 6);
    expect(route[route.length - 1].distanceTo(latLonToVector(...CITIES.tyo, 1.014))).toBeCloseTo(
      0,
      6
    );
  });

  it("takes the short way across the antimeridian", () => {
    const route = routePoints(CITIES.tyo, CITIES.sfo, 1);
    // Inverse of latLonToVector: theta = lon + 180, wrapped back into [-180, 180).
    const longitudes = route.map((point) => {
      const theta = (Math.atan2(point.z, -point.x) * 180) / Math.PI;
      return ((theta - 180 + 540) % 360) - 180;
    });

    // Tokyo → San Francisco crosses 180°, never passes over Europe or Africa near 0°.
    expect(longitudes.some((lon) => Math.abs(lon) < 30)).toBe(false);
  });
});
