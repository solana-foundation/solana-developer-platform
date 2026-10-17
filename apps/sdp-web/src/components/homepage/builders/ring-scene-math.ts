/* The shot's timing, kept apart from three.js so it can be tested. */
import { clamp } from "@/lib/easing";

/* the reference's timeline: five moves, durations 1, 1, 2, 3.5, 1 of 8.5 */
type Move = { d: number; to: [number, number, number]; look: number };
function moves(cz: number): Move[] {
  return [
    { d: 1, to: [0, 0, cz], look: 1 },
    { d: 1, to: [0, 5, 5], look: 0 },
    { d: 2, to: [1.5, 2, 2], look: 0 },
    /* inside, a step further from the wall than the reference, for two rows */
    { d: 3.5, to: [0.3, 0, 0.4], look: 0 },
    /* pulled out low, the ring up, room for the closing words */
    { d: 1, to: [-6, -1, cz], look: -1.7 },
  ];
}

export function cameraDistance(width: number) {
  return width < 768 ? 6 : width < 1024 ? 7 : 8;
}

function ease(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * The captions' opacity at progress `p`: one caption per equal share of the shot, in over the
 * first fifth of its share and out over the last. The opening one is already there as the shot
 * arrives; the closing one stays.
 */
export function captionOpacity(p: number, index: number, count: number) {
  const share = 1 / count;
  const start = index * share;
  const end = (index + 1) * share;
  if (index === 0 && p <= 0) return 1;
  if (p < start || p > end) return 0;
  const u = (p - start) / share;
  if (index === count - 1) return Math.min(1, u / 0.2);
  if (index === 0) return u > 0.8 ? (1 - u) / 0.2 : 1;
  return u < 0.2 ? u / 0.2 : u > 0.8 ? (1 - u) / 0.2 : 1;
}

/** Where the camera is at progress `p`, and the height it looks at. */
export function cameraAt(p: number, cz: number) {
  const timeline = moves(cz);
  const total = timeline.reduce((sum, move) => sum + move.d, 0);
  let from: [number, number, number] = [0, 0, cz];
  let fromLook = 1;
  let t = p * total;
  for (const [i, move] of timeline.entries()) {
    if (t <= move.d || i === timeline.length - 1) {
      const u = ease(clamp(t / move.d));
      return {
        position: [
          from[0] + (move.to[0] - from[0]) * u,
          from[1] + (move.to[1] - from[1]) * u,
          from[2] + (move.to[2] - from[2]) * u,
        ] as const,
        look: fromLook + (move.look - fromLook) * u,
      };
    }
    t -= move.d;
    from = move.to;
    fromLook = move.look;
  }
  return { position: [0, 0, cz] as const, look: 1 };
}
