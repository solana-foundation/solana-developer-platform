/**
 * The same payment on several rails, drawn on a 2D canvas: a signal leaves
 * every rail at once; on Solana it reaches the far end in 0.4 s and settles
 * with a ripple, while the others are still crawling (their crossing takes as
 * many seconds as the real thing takes days). In "one" mode there is a single
 * rail: one payment, from one party to another.
 */

import { easeInOutQuad } from "../easing";
import { watchSize } from "../size";

export type SpeedMode = "race" | "one";

type Lane = { seconds: number; color: string; fast: boolean };

/** Solana first; the card networks, ACH and SWIFT after it. */
const RACE_LANES: Lane[] = [
  { seconds: 0.42, color: "#dc1fff", fast: true },
  { seconds: 16, color: "#6e6a78", fast: false },
  { seconds: 22, color: "#6e6a78", fast: false },
  { seconds: 30, color: "#6e6a78", fast: false },
];
const ONE_LANE: Lane[] = [{ seconds: 0.42, color: "#dc1fff", fast: true }];

const LAUNCH_EVERY_S = 2.4;
const GREEN = "#14f195";

/** Where lane `index` of `count` sits, as a fraction of the box's height. */
export function laneTop(mode: SpeedMode, index: number, count: number): number {
  return mode === "one" ? 0.5 : 0.18 + (index * 0.64) / (count - 1);
}

/** The rails drawn in `mode`: the four-way race, or the single Solana lane. */
export function lanesFor(mode: SpeedMode): readonly Lane[] {
  return mode === "one" ? ONE_LANE : RACE_LANES;
}

type SpeedOptions = {
  mode: SpeedMode;
  reducedMotion: boolean;
  /** Called each time a Solana payment settles. */
  onSettle: () => void;
};

/** Draws into `canvas`, sized to `host`, until the returned function is called. */
export function mountSpeed(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  options: SpeedOptions
): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  const lanes = lanesFor(options.mode);

  let width = 0;
  let height = 0;
  let ratio = 1;
  let left = 0;
  let right = 0;
  const resize = watchSize(host, (w, h, r) => {
    width = w;
    height = h;
    ratio = r;
    canvas.width = Math.round(w * r);
    canvas.height = Math.round(h * r);
    if (options.mode === "one") {
      left = 28;
      right = w - 28;
    } else {
      // The settled feed takes the right of the band on wide screens.
      left = 0;
      right = w - 28;
    }
  });
  const laneY = (index: number) => height * laneTop(options.mode, index, lanes.length);

  const drawRail = (y: number) => {
    context.strokeStyle = "rgba(255,255,255,.12)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
  };
  const dot = (x: number, y: number, radius: number, color: string) => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  };

  resize();
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  if (options.reducedMotion) {
    // Drawn once, settled: Solana at the far end, the others barely started.
    lanes.forEach((lane, index) => {
      const y = laneY(index);
      drawRail(y);
      dot(left + (right - left) * (lane.fast ? 1 : 0.06), y, 3, lane.fast ? GREEN : lane.color);
    });
    options.onSettle();
    return () => {};
  }

  const signals: number[][] = lanes.map(() => []);
  const ripples: { x: number; y: number; t: number }[] = [];
  const launch = () => {
    for (const lane of signals) lane.push(0);
  };

  const drawSignal = (lane: Lane, y: number, progress: number) => {
    const eased = lane.fast ? easeInOutQuad(progress) : progress;
    const x = left + (right - left) * eased;
    const trail = lane.fast ? 140 : 46;
    const gradient = context.createLinearGradient(x - trail, y, x, y);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(1, lane.color);
    context.strokeStyle = gradient;
    context.lineWidth = lane.fast ? 2 : 1.5;
    context.beginPath();
    context.moveTo(Math.max(left, x - trail), y);
    context.lineTo(x, y);
    context.stroke();
    context.shadowColor = lane.color;
    context.shadowBlur = lane.fast ? 18 : 8;
    dot(x, y, lane.fast ? 3 : 2.2, lane.fast ? "#ffffff" : lane.color);
    context.shadowBlur = 0;
  };

  const drawRipples = (dt: number) => {
    for (let i = ripples.length - 1; i >= 0; i--) {
      const ripple = ripples[i];
      ripple.t += dt;
      const k = Math.min(1, ripple.t / 0.9);
      context.strokeStyle = `rgba(20,241,149,${(0.9 * (1 - k) * (1 - k)).toFixed(3)})`;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(ripple.x, ripple.y, 3 + 26 * (1 - (1 - k) ** 3), 0, Math.PI * 2);
      context.stroke();
      if (k >= 1) ripples.splice(i, 1);
    }
  };

  let visible = true;
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    },
    { threshold: 0.05 }
  );
  observer.observe(host);

  let last = performance.now();
  let sinceLaunch = 0;
  let frameId = 0;
  const frame = (now: number) => {
    frameId = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!visible || document.hidden) return;
    resize();
    sinceLaunch += dt;
    if (sinceLaunch > LAUNCH_EVERY_S) {
      sinceLaunch = 0;
      launch();
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    lanes.forEach((lane, index) => {
      const y = laneY(index);
      drawRail(y);
      const pending = signals[index];
      for (let k = pending.length - 1; k >= 0; k--) {
        pending[k] += dt / lane.seconds;
        const progress = Math.min(1, pending[k]);
        drawSignal(lane, y, progress);
        if (progress >= 1) {
          pending.splice(k, 1);
          if (lane.fast) {
            ripples.push({ x: right, y, t: 0 });
            options.onSettle();
          }
        }
      }
    });
    drawRipples(dt);
    dot(right, laneY(0), 2.5, GREEN);
  };
  launch();
  frameId = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(frameId);
    observer.disconnect();
  };
}
