/** The stack's timing: one service every 4.2s, its knob 3s along the track. */
export const SERVICE_CYCLE_MS = 4200;
export const KNOB_LAUNCH_DELAY_MS = 420;
export const KNOB_RUN_MS = 3000;
export const PRODUCT_CYCLE_MS = 2600;
/** On a wide screen the product starts its own words a little after the services. */
export const PRODUCT_WIDE_START_MS = -2200;
/** After the drawing's block lands, the route waits this long before it starts. */
export const ROUTE_START_DELAY_MS = 900;

/** The knob's path, in percent of the drawing's width, and where it meets SDP and the product. */
const KNOB_FROM = 17;
const KNOB_TO = 83;
export const KNOB_HITS_SDP = 46;
export const KNOB_HITS_PRODUCT = 79;

/** What each payment brings in, in turn. */
export const RECEIVED_AMOUNTS = [840, 24800, 96.4, 12500, 3300, 410] as const;

function easeInOutSine(u: number): number {
  return -(Math.cos(Math.PI * u) - 1) / 2;
}

/** The knob's left edge (percent) after `elapsedMs` of its run. */
export function knobPosition(elapsedMs: number): number {
  const u = Math.min(1, Math.max(0, elapsedMs / KNOB_RUN_MS));
  return KNOB_FROM + (KNOB_TO - KNOB_FROM) * easeInOutSine(u);
}

/** The knob shows only while it is on its way, not while it sits at either end. */
export function knobVisible(elapsedMs: number): boolean {
  const u = elapsedMs / KNOB_RUN_MS;
  return u > 0.02 && u < 0.985;
}
