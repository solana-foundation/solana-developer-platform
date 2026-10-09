/* FIG_004 Batch. A payout file read into rows, the rows paid lying on the sheet, ticked in green.
   Motion: the rows go, show again overhead without their ticks, then one after another, the
   nearest first, each comes down onto its slot; only once it is down does its tick light, with a
   ping. The picture ends as it began. */
import type { Pt } from "../geometry";
import { type Key, makeFig, rrect, T } from "../make-fig";
import type { SceneInput } from "../scene-input";

/* the prototype's demo counterparties, with amounts */
const WHO = ["Marcus Reid", "Lena Fischer", "Ana Souza"];
const AM = [120, 84.5, 310];

export function batchScene({ fonts, label, copy }: SceneInput): string {
  /* drawn a fifth larger than the other scenes, the sheet being compact; the floor grid keeps the
     same cell on screen as theirs */
  const K = 1.2;
  const g = makeFig({ ox: 320, oy: 262, k: K, id: "bat", cycle: 2800, label, fonts });
  g.grid({ cx: 0, cy: 0, step: 40 / K, n: Math.ceil(9 * K) });
  const X = -120;
  const Y = -85;
  const W = 240;
  const D = 170;
  const RH = 34;
  const rowY = (i: number) => Y + 54 + i * RH;
  const LIFT = [0, 1, 2];
  const Z = 50;

  /* the sheet, and the slots under the rows lying in them */
  const t = g.panel(X, Y, 0, W, D, { heading: "batch.csv" });
  for (const i of LIFT) {
    const y = rowY(i);
    g.flat(rrect(X + 8, y - 11, W - 16, 22, 8), t, { dash: "2 3", op: 0.45 });
  }

  /* one element per row, from rest to rest: the row lies on the sheet, goes (OUT), shows again
     overhead (IN), comes down from at(k), the nearest first, and is fixed in its slot at fix(k);
     only then is it ticked */
  const OUT = 260;
  const IN = 540;
  const at = (k: number) => 620 + (2 - k) * 450;
  const fix = (k: number) => at(k) + 520;
  const UPZ = Z - t;
  const slab = (i: number, y: number) => {
    const s = g.panel(X + 8, y - 11, t, W - 16, 22, { h: 4, r: 8, shadow: false });
    g.sans(WHO[i], X + 24, y + 4.5, s);
    g.sans(copy.number(AM[i], 2), X + W - 46, y + 4.5, s, { anchor: "end" });
    return s;
  };
  const tick = (y: number, s: number) => {
    g.dot(X + W - 26, y, s, 6.4, g.ACCENT);
    g.tick(X + W - 26, y, s, 0.7, "#fff", 2);
  };

  /* the count under the rows: all three paid at rest; none once they lift off, then one more
     each time a row is down and ticked. Each figure is its own text, turned over on the beat */
  const L = LIFT.map((k) => fix(k) + 135).sort((p, q) => p - q);
  const off = (ms: number): Key[] => [
    [ms - 1, {}],
    [ms, { o: 0 }],
  ];
  const on = (ms: number): Key[] => [
    [ms - 1, { o: 0 }],
    [ms, {}],
  ];
  const said: [Key[], { o?: number }][] = [
    [[...off(OUT), ...on(L[2])], {}],
    [[...on(OUT), ...off(L[0])], { o: 0 }],
    [[...on(L[0]), ...off(L[1])], { o: 0 }],
    [[...on(L[1]), ...off(L[2])], { o: 0 }],
  ];
  [3, 0, 1, 2].forEach((n, j) => {
    const [frames, rest] = said[j];
    g.move(
      `n${n}`,
      frames,
      () => g.sans(copy.paidCount(n, 3), X + 16, Y + D - 14, t, { size: 11.5, fill: T.t5 }),
      { rest, hidden: n !== 3 }
    );
  });

  /* the guides from each slot up to its row overhead, there only while the row waits */
  LIFT.forEach((li, k) => {
    const y = rowY(li);
    g.keys(
      `g${k}`,
      [
        [OUT, { sy: 0.01, o: 0 }, "out"],
        [IN, { sy: 1, o: 0.3 }],
        [at(k), { sy: 1, o: 0.3 }, "inOut"],
        [fix(k), { sy: 0.01, o: 0 }],
      ],
      { sy: 0.01, o: 0 },
      "50% 100%"
    );
    /* standing on the middle of each seen corner's curve, where slot and row outlines pass */
    const k45 = 8 * Math.SQRT1_2;
    const feet: Pt[] = [
      [X + 16 - k45, y + 3 + k45],
      [X + W - 16 + k45, y + 3 + k45],
      [X + W - 16 + k45, y - 3 - k45],
    ];
    for (const [x, yy] of feet) {
      g.line([x, yy, t], [x, yy, Z], { dash: "2 3", op: "0", cls: `bat-g${k}` });
    }
  });

  LIFT.forEach((li, k) => {
    const y = rowY(li);
    const a = (2 - k) * 60;
    const HIGH = { o: 1, d: [0, 0, UPZ] };
    g.move(
      `row${k}`,
      [
        [0, {}, "out"],
        [OUT, { o: 0 }],
        [OUT + 1, { o: 0, d: [0, 0, UPZ + 12] }],
        [OUT + a, { o: 0, d: [0, 0, UPZ + 12] }, "out"],
        [IN + a, HIGH],
        [at(k), HIGH, "inOut"],
        [fix(k), {}],
      ],
      () => {
        const s = slab(k, y);
        /* the tick goes with the row, stays off while it waits overhead, and lights only once
           the row is down */
        g.move(
          `ok${k}`,
          [
            [OUT, {}],
            [OUT + 1, { o: 0 }],
            [fix(k) + 120, { o: 0 }, "out"],
            [fix(k) + 280, {}],
          ],
          () => tick(y, s)
        );
        g.ping(`pk${k}`, X + W - 26, y, s, 6.4, fix(k) + 180);
      }
    );
  });
  return g.svg();
}
