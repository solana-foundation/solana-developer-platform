/*
 * The speed race, drawn.
 * Four rails across the box; one payment leaves on each at the same moment. On Solana it crosses in
 * ~0.4s and settles with a green pulse; the card, ACH and SWIFT signals crawl, taking as many
 * seconds as the real thing takes days. Drawn in the night palette of the network's dark panel.
 * Pure drawing: the component owns the loop.
 */

export const LANE_SECONDS = [0.42, 16, 22, 30] as const;

/** Seconds between payments. */
export const LAUNCH_EVERY = 2.4;

/** Room the settle pulse needs at the rails' end when the settlements list is hidden. */
const NARROW_RIGHT_INSET = 24;

const RAIL = "rgba(255,255,255,.12)";
const FAST = "#DC1FFF";
const SLOW = "#6E6A78";
const SETTLE = "#14F195";
const RIPPLE_SECONDS = 0.9;

export type Signal = { t: number };
export type Ripple = { y: number; t: number };

export type RaceState = {
  lanes: Signal[][];
  ripples: Ripple[];
};

export type Geometry = { width: number; height: number; right: number };

export function createRaceState(): RaceState {
  return { lanes: LANE_SECONDS.map(() => []), ripples: [] };
}

/** The rails sit at 18%, 39.33%, 60.67% and 82% of the box's height. */
export function laneFraction(index: number): number {
  return 0.18 + (index * 0.64) / (LANE_SECONDS.length - 1);
}

/**
 * Where the rails end. With the settlements list beside them they end with the page's second
 * column (the list takes the third, 26px gutters); without it they run the width less the inset.
 */
export function railEnd(width: number, withFeed: boolean): number {
  return withFeed ? (2 * width - 26) / 3 : width - NARROW_RIGHT_INSET;
}

/** One payment leaves on every rail at once. */
export function launch(state: RaceState): void {
  for (const lane of state.lanes) lane.push({ t: 0 });
}

function easeInOutQuad(u: number): number {
  return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
}

/**
 * Advances the race by `dt` seconds and paints it. Returns how many Solana payments settled in
 * this step, so the caller can write them into the list.
 */
export function stepAndDraw(
  ctx: CanvasRenderingContext2D,
  state: RaceState,
  geometry: Geometry,
  dt: number
): number {
  const { width, height, right } = geometry;
  const left = 0;
  let settled = 0;
  ctx.clearRect(0, 0, width, height);

  state.lanes.forEach((signals, index) => {
    const fast = index === 0;
    const y = height * laneFraction(index);

    ctx.strokeStyle = RAIL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    for (let k = signals.length - 1; k >= 0; k--) {
      const signal = signals[k];
      signal.t += dt / LANE_SECONDS[index];
      const u = Math.min(1, signal.t);
      const x = left + (right - left) * (fast ? easeInOutQuad(u) : u);

      const trail = fast ? 140 : 46;
      const color = fast ? FAST : SLOW;
      const gradient = ctx.createLinearGradient(x - trail, y, x, y);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(1, color);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = fast ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.max(left, x - trail), y);
      ctx.lineTo(x, y);
      ctx.stroke();

      /* the head: white with a magenta glow on Solana, the rail's grey on the others */
      ctx.shadowColor = color;
      ctx.shadowBlur = fast ? 18 : 8;
      ctx.fillStyle = fast ? "#FFFFFF" : color;
      ctx.beginPath();
      ctx.arc(x, y, fast ? 3 : 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (u >= 1) {
        signals.splice(k, 1);
        if (fast) {
          state.ripples.push({ y, t: 0 });
          settled += 1;
        }
      }
    }
  });

  /* a green ring where Solana settled, opening out as it fades */
  for (let j = state.ripples.length - 1; j >= 0; j--) {
    const ripple = state.ripples[j];
    ripple.t += dt;
    const k = Math.min(1, ripple.t / RIPPLE_SECONDS);
    ctx.strokeStyle = `rgba(20,241,149,${(0.9 * (1 - k) * (1 - k)).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(right, ripple.y, 3 + 26 * (1 - (1 - k) ** 3), 0, Math.PI * 2);
    ctx.stroke();
    if (k >= 1) state.ripples.splice(j, 1);
  }

  /* the end of the Solana line: where it settles */
  ctx.fillStyle = SETTLE;
  ctx.beginPath();
  ctx.arc(right, height * laneFraction(0), 2.5, 0, Math.PI * 2);
  ctx.fill();

  return settled;
}

/** The still for reduced motion: Solana settled at the end of its rail, the others just leaving. */
export function drawStill(ctx: CanvasRenderingContext2D, geometry: Geometry): void {
  const { width, height, right } = geometry;
  ctx.clearRect(0, 0, width, height);
  LANE_SECONDS.forEach((_, index) => {
    const fast = index === 0;
    const y = height * laneFraction(index);
    ctx.strokeStyle = RAIL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = fast ? SETTLE : SLOW;
    ctx.beginPath();
    ctx.arc(fast ? right : right * 0.06, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}
