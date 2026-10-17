/** The six payment kinds, in the order the bench walks them. */
export const PAYMENT_KINDS = ["pay", "request", "recurring", "batch", "micro", "deposit"] as const;

export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/**
 * Each kind's mark, carried by its word in the bubble (24-unit viewBox). `pathLength` matters to
 * nothing here but is kept so the marks draw identically.
 */
export const KIND_ICONS: Record<
  PaymentKind,
  readonly ({ d: string } | { cx: number; cy: number; r: number })[]
> = {
  pay: [{ d: "M7 17 17 7" }, { d: "M8 7h9v9" }],
  request: [{ d: "M6 3h9l4 4v14H6Z" }, { d: "M14 3v5h5" }, { d: "M9 13h6M9 17h6" }],
  recurring: [
    { d: "m17 2 4 4-4 4" },
    { d: "M3 11V9a4 4 0 0 1 4-4h14" },
    { d: "m7 22-4-4 4-4" },
    { d: "M21 13v2a4 4 0 0 1-4 4H3" },
  ],
  batch: [{ d: "m12 3 9 5-9 5-9-5 9-5Z" }, { d: "m3 12 9 5 9-5" }, { d: "m3 16 9 5 9-5" }],
  micro: [
    { cx: 9, cy: 9, r: 5.2 },
    { d: "M17.6 10.6a5.2 5.2 0 1 1-7 7" },
    { d: "M8.2 7.4H9.4v3.4" },
  ],
  deposit: [{ d: "M12 4v11" }, { d: "m7 10 5 5 5-5" }, { d: "M4 20h16" }],
};

/**
 * On a phone each drawing is framed close on what it draws, moving parts included, rather than
 * on the whole floor: measured from the scenes, in their own 640 x 520 units.
 */
const SNUG_FRAMES: Record<PaymentKind, readonly [number, number, number, number]> = {
  pay: [62, 71, 582, 450],
  request: [41, 107, 597, 413],
  recurring: [101, 129, 551, 415],
  batch: [113, 98, 527, 391],
  micro: [75, 112, 570, 412],
  deposit: [88, 90, 551, 432],
};

/** The viewBox for a drawing: the whole floor, or framed close with a margin for the fade. */
export function figureViewBox(kind: PaymentKind, snug: boolean): string {
  if (!snug) return "0 0 640 520";
  const [x0, y0, x1, y1] = SNUG_FRAMES[kind];
  const margin = 26;
  return [x0 - margin, y0 - margin, x1 - x0 + 2 * margin, y1 - y0 + 2 * margin].join(" ");
}
