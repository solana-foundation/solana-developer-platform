/** The six payment kinds, in the order the bench walks them. */
export const PAYMENT_KINDS = ["pay", "request", "recurring", "batch", "micro", "deposit"] as const;

export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/**
 * On a phone each drawing is framed close on what it draws, moving parts included, rather than
 * on the whole floor: measured from the scenes, in their own 640 x 520 units.
 */
const SNUG_FRAMES = {
  pay: [62, 71, 582, 450],
  request: [41, 107, 597, 413],
  recurring: [101, 129, 551, 415],
  batch: [113, 98, 527, 391],
  micro: [75, 112, 570, 412],
  deposit: [88, 90, 551, 432],
} as const satisfies Record<PaymentKind, readonly [number, number, number, number]>;

/** The viewBox for a drawing: the whole floor, or framed close with a margin for the fade. */
export function figureViewBox(kind: PaymentKind, snug: boolean): string {
  if (!snug) return "0 0 640 520";
  const [x0, y0, x1, y1] = SNUG_FRAMES[kind];
  const margin = 26;
  return [x0 - margin, y0 - margin, x1 - x0 + 2 * margin, y1 - y0 + 2 * margin].join(" ");
}
