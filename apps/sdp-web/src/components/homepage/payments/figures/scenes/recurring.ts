/* FIG_003 Recurring. The schedule card: the amount, how often, when it starts, the next run.
   From its edge the run history steps out along the floor, one payment a period.
   Motion: a green ring fills round the next run like a timer; when it closes the run fires by
   itself: the coin hops, its green dot turns into a tick, a ping, and Next run moves on a month.
   Then the history steps back by one, so the picture is the one it started from, a month later;
   the dates move on as it is put back to rest, so it loops without a seam. */
import type { Pt } from "../geometry";
import { circ, INK, makeFig, T } from "../make-fig";
import type { SceneInput } from "../scene-input";

const AUG = 7;

export function recurringScene({ fonts, label, copy }: SceneInput): string {
  const g = makeFig({ ox: 335, oy: 306, id: "rec", cycle: 2400, label, fonts });
  const w = copy.words;
  /* dates are data in the drawing, set in the reader's locale */
  const MONTHS = Array.from({ length: 12 }, (_, m) => copy.monthStart(m));
  g.grid({ cx: 0, cy: 0 });
  const END = 2400;
  const S = { x: -230, y: -120, w: 200, d: 166 };
  const ry = -37;
  const xs = [30, 92, 154, 216];
  const PITCH = 62;
  const CR = 15;
  /* the run fires at F, the history steps between SH0 and SH1 */
  const F = 900;
  const SH0 = 1450;
  const SH1 = 2150;
  const seq = (i: number) => `data-seq="${MONTHS.join("|")}" data-i="${AUG + i}"`;
  const date = (i: number, x: number, fill: string) =>
    g.label(MONTHS[(AUG + i) % 12], x, ry + 40, 0, {
      size: 14,
      ls: 0,
      weight: 500,
      font: g.SANS,
      fill,
      attrs: seq(i),
    });
  /* a part that fades between a and b over [t0, t1] and holds there */
  const fade = (
    name: string,
    a: number,
    b: number,
    t0: number,
    t1: number,
    fn: () => void,
    s0 = 1
  ) =>
    g.move(
      name,
      [
        [t0, { o: a, s: s0 }, "inOut"],
        [t1, { o: b }],
        [END, { o: b }],
      ],
      fn,
      {
        rest: { o: a, s: s0 },
        hidden: a === 0,
      }
    );
  const coin = (x: number, mark: "tick" | "next" | null, shadow = true) => {
    if (shadow) g.shadow(circ(x, ry, CR, 48), { dx: 6, dy: 6, op: 0.06 });
    g.coin(x, ry, 0, CR, 5);
    if (mark === "tick") g.tick(x, ry, 5, 0.8);
    if (mark === "next") g.dot(x, ry, 5, 5, g.ACCENT);
  };

  /* the run history, straight out of the card's edge; dashed past the next run */
  g.wire([
    [S.x + S.w, ry],
    [xs[1], ry],
  ]);
  g.wire(
    [
      [xs[1], ry],
      [xs[2] + 40, ry],
    ],
    { dash: "3 4" }
  );

  /* the timer round the next run: drawn under the coin, filling evenly */
  const ring: Pt[] = circ(xs[1], ry, CR + 7, 72, -Math.PI * 0.75, Math.PI * 1.25).map(([x, y]) =>
    g.P(x, y, 0)
  );
  g.raw(
    `<path class="rec-timer" d="${g.d2(ring, true)}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1" fill="none" stroke="${g.ACCENT}" stroke-width="1.5" stroke-linecap="round" opacity="0"/>`
  );
  g.keys(
    "timer",
    [
      [0, { o: 0, x: "stroke-dashoffset:1" }],
      [120, { o: 1, x: `stroke-dashoffset:${1 - 120 / F}` }],
      [F, { o: 1, x: "stroke-dashoffset:0" }],
      [F + 160, { o: 0, x: "stroke-dashoffset:0" }],
    ],
    { o: 0, x: "stroke-dashoffset:1" }
  );

  /* the history, on a belt that steps back one period */
  g.move(
    "belt",
    [
      [SH0, {}, "inOut"],
      [SH1, { d: [-PITCH, 0, 0] }],
      [END, { d: [-PITCH, 0, 0] }],
    ],
    () => {
      /* the run made before, going under the card */
      fade("p0", 1, 0, SH0 + 80, SH0 + 420, () => {
        coin(xs[0], "tick");
        date(0, xs[0], T.t5);
      });
      /* the next run: it fires, hops, and its dot turns to a tick */
      g.shadow(circ(xs[1], ry, CR, 48), { dx: 6, dy: 6, op: 0.06 });
      g.move(
        "fire",
        [
          [F, {}, "out"],
          [F + 170, { d: [0, 0, 8] }, "in"],
          [F + 380, {}],
        ],
        () => {
          coin(xs[1], null, false);
          fade("dot", 1, 0, F + 110, F + 200, () => g.dot(xs[1], ry, 5, 5, g.ACCENT));
          fade("tk", 0, 1, F + 130, F + 250, () => g.tick(xs[1], ry, 5, 0.8));
        }
      );
      g.ping("done", xs[1], ry, 5, 8, F + 380, 520);
      fade("d1a", 1, 0, SH0, SH1, () => date(1, xs[1], INK));
      fade("d1b", 0, 1, SH0, SH1, () => date(1, xs[1], T.t5));
      /* the slot after: it becomes the next run */
      fade("s2", 1, 0, SH0 + 100, SH0 + 400, () =>
        g.flat(circ(xs[2], ry, CR, 48), 0, { dash: "2.5 3", fill: T.white })
      );
      fade("c2", 0, 1, SH0 + 100, SH0 + 460, () => coin(xs[2], "next"), 0.85);
      fade("d2a", 1, 0, SH0, SH1, () => date(2, xs[2], T.t5));
      fade("d2b", 0, 1, SH0, SH1, () => date(2, xs[2], INK));
      /* and a new slot comes in at the far end */
      fade("p3", 0, 1, SH0 + 200, SH1, () => {
        g.flat(circ(xs[3], ry, CR, 48), 0, { dash: "2.5 3", fill: T.white });
        date(3, xs[3], T.t5);
      });
    }
  );

  /* the schedule: the amount, then three rows, the values in a column a set gap past the
     widest label; Next run moves on a month when the run fires */
  const t = g.panel(S.x, S.y, 0, S.w, S.d, { heading: w.schedule });
  const scheduled = copy.number(1200, 2);
  g.amount(scheduled, S.x + 16, S.y + 64, t, { size: 28 });
  g.text("USDC", S.x + 16 + g.measure(scheduled, { size: 28 }) + 7, S.y + 64, t, {
    size: 10,
    fill: T.t5,
  });
  const rows = [
    [w.howOften, w.monthly],
    [w.startsOn, MONTHS[AUG]],
    [w.nextRun, MONTHS[AUG + 1]],
  ];
  const FS = 12;
  const col = S.x + 16 + Math.max(...rows.map(([k]) => g.measure(k, { size: FS }))) + 20;
  rows.forEach(([k, v], i) => {
    const y = S.y + 100 + i * 23;
    g.sans(k, S.x + 16, y, t, { size: FS, fill: T.t5 });
    g.sans(v, col, y, t, { size: FS, attrs: i === 2 ? `${seq(1)} data-step-at="${F + 250}"` : "" });
  });
  return g.svg();
}
