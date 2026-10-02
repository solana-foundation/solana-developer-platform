import type * as THREE from "three";
import { easeInOutCubic } from "../easing";

/** The ring turns this many times over the whole shot, as the design sets it. */
export const TURNS = 1.25;

type Move = { seconds: number; to: [number, number, number]; look: number };

/**
 * The camera's path: outside the ring, up to look down into it, in among the
 * stills, and back out low with the ring above the closing words. The look
 * point slides so the ring sits under the opening caption and over the last.
 */
export function makeShot(viewportWidth: number) {
  const distance = viewportWidth < 768 ? 6 : viewportWidth < 1024 ? 7 : 8;
  const moves: Move[] = [
    { seconds: 1.0, to: [0, 0, distance], look: 1.0 },
    { seconds: 1.0, to: [0, 5, 5], look: 0 },
    { seconds: 2.0, to: [1.5, 2, 2], look: 0 },
    { seconds: 3.5, to: [0.3, 0, 0.4], look: 0 },
    { seconds: 1.0, to: [-6, -1, distance], look: -1.7 },
  ];
  const total = moves.reduce((sum, move) => sum + move.seconds, 0);

  /** Places the camera for progress `p` (0..1) through the shot. */
  return (p: number, camera: THREE.PerspectiveCamera, look: THREE.Vector3) => {
    let from: [number, number, number] = [0, 0, distance];
    let fromLook = 1.0;
    let t = p * total;
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (t <= move.seconds || i === moves.length - 1) {
        const u = easeInOutCubic(t / move.seconds);
        camera.position.set(
          from[0] + (move.to[0] - from[0]) * u,
          from[1] + (move.to[1] - from[1]) * u,
          from[2] + (move.to[2] - from[2]) * u
        );
        look.set(0, fromLook + (move.look - fromLook) * u, 0);
        camera.lookAt(look);
        return;
      }
      t -= move.seconds;
      from = move.to;
      fromLook = move.look;
    }
  };
}
