import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { makeShot } from "./shot";

function cameraAt(progress: number, viewportWidth = 1280) {
  const camera = new THREE.PerspectiveCamera();
  const look = new THREE.Vector3();
  makeShot(viewportWidth)(progress, camera, look);
  return { position: camera.position.toArray(), look: look.toArray() };
}

describe("the builders' camera path", () => {
  it("starts outside the ring, looking a little above its middle", () => {
    expect(cameraAt(0)).toEqual({ position: [0, 0, 8], look: [0, 1, 0] });
  });

  it("goes inside the ring before pulling back out", () => {
    const inside = cameraAt(7.5 / 8.5);
    const distanceFromAxis = Math.hypot(inside.position[0], inside.position[2]);

    expect(distanceFromAxis).toBeLessThan(2.5);
  });

  it("ends out low, with the ring above the closing words", () => {
    const end = cameraAt(1);

    expect(end.position[0]).toBeCloseTo(-6);
    expect(end.position[1]).toBeCloseTo(-1);
    expect(end.position[2]).toBeCloseTo(8);
    expect(end.look[1]).toBeCloseTo(-1.7);
  });

  it("stands closer on smaller screens", () => {
    expect(cameraAt(0, 1000).position[2]).toBe(7);
    expect(cameraAt(0, 375).position[2]).toBe(6);
  });
});
