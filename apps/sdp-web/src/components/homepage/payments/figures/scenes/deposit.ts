/* FIG_006 Deposit. Pay by card through a provider, and the wallet receives USDC: a ramp, the card
   at its foot, a coin on its way up (lying on the ramp, tilted to its slope), the wallet card on
   top with the deposit received.
   Motion: the card is tapped, the coin climbs the ramp onto the wallet and is taken in, the
   balance runs up by 500.00, the status pings, and the next coin settles back on the ramp. */
import type { Pt } from "../geometry";
import { attr, INK, type Key, makeFig, rrect, SW, T } from "../make-fig";
import type { SceneInput } from "../scene-input";

export function depositScene({ fonts, label, copy }: SceneInput): string {
  const g = makeFig({ ox: 243, oy: 241, id: "dep", cycle: 1900, label, fonts });
  const w = copy.words;
  g.grid({ cx: 0, cy: 20 });
  const C = { x: 0, y: -186, w: 176, d: 128 };
  const Z = 56;
  /* the ramp keeps the same gap to the wallet at its top as to the card at its foot */
  const x0 = 70;
  const x1 = 124;
  const y1 = 120;
  const GAP = 14;
  const y0 = C.y + C.d + GAP;
  const zt = Z;

  /* the card's posts, then the card */
  const posts: Pt[] = [
    [C.x + C.w - 12, C.y + 12],
    [C.x + C.w - 12, C.y + C.d - 12],
    [C.x + 12, C.y + C.d - 12],
  ];
  for (const [x, y] of posts) g.line([x, y, 0], [x, y, Z], { dash: "2 4", op: 0.28 });
  const t = g.panel(C.x, C.y, Z, C.w, C.d, { heading: w.wallet });
  /* the balance: up by the 500.00 deposited as the coin is taken in; tabular figures */
  const BAL = 'style="font-variant-numeric:tabular-nums"';
  g.amount(copy.number(1250, 2), C.x + 16, C.y + 70, t, {
    size: 25,
    attrs: `${BAL} data-n="1250" data-step="500" data-dec="2" data-at="980" data-dur="560" data-max="3000"`,
  });
  /* the widest the balance gets, as zeros */
  const widest = copy.number(3000, 2).replace(/\d/g, "0");
  g.text("USDC", C.x + 16 + g.measure(widest, { size: 25 }) + 6, C.y + 70, t, {
    size: 10,
    fill: T.t5,
  });
  const [sx, sy, sr] = g.status(w.depositReceived, C.x + 16, C.y + 102, t);
  g.ping("got", sx, sy, t, sr, 1060);

  /* the ramp, from the floor to the card's front edge */
  g.shadow(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    { dx: 6, dy: 6, op: 0.05 }
  );
  const poly = (a: Pt[], f: string) =>
    g.raw(
      `<polygon points="${g.pts(a.map(g.P3))}" fill="${f}" stroke="${g.LINE}" stroke-width="1" stroke-linejoin="round" ${SW}/>`
    );
  poly(
    [
      [x1, y0, 0],
      [x1, y0, zt],
      [x1, y1, 0],
    ],
    T.t2
  );
  poly(
    [
      [x0, y0, zt],
      [x1, y0, zt],
      [x1, y1, 0],
      [x0, y1, 0],
    ],
    T.white
  );
  const zAt = (y: number) => (zt * (y1 - y)) / (y1 - y0);
  const xm = (x0 + x1) / 2;
  /* the track up the ramp: the coin rests on its start and rides it to its end */
  const ys = y1 - 18;
  const ye = y0 + 10;
  g.line([xm, ys, zAt(ys) + 2], [xm, ye, zAt(ye) + 2], { dash: "3 4", arrow: true, op: 0.7 });

  /* the coin's faces lie in the ramp's plane (across it along x, up it along v), its thickness
     along the ramp's normal n */
  const sl = zt / (y1 - y0);
  const L = Math.hypot(1, sl);
  const v = [0, 1 / L, -sl / L];
  const n = [0, sl / L, 1 / L];
  const tilted = (cx: number, cy: number, r: number, h: number) => {
    const cz = zAt(cy);
    const ring = (rr: number, lift: number) =>
      [...Array(48).keys()].map((i) => {
        const a = (i / 48) * Math.PI * 2;
        const c = Math.cos(a) * rr;
        const d = Math.sin(a) * rr;
        return g.P(cx + c, cy + d * v[1] + lift * n[1], cz + d * v[2] + lift * n[2]);
      });
    const bot = ring(r, 1);
    const top = ring(r, 1 + h);
    /* the side: the outline round both faces (a convex hull), in the side's grey */
    const all = [...bot, ...top].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o: Pt, a2: Pt, b2: Pt) =>
      (a2[0] - o[0]) * (b2[1] - o[1]) - (a2[1] - o[1]) * (b2[0] - o[0]);
    const half = (list: Pt[]) => {
      const hh: Pt[] = [];
      for (const p of list) {
        while (hh.length > 1 && cross(hh[hh.length - 2], hh[hh.length - 1], p) <= 0) hh.pop();
        hh.push(p);
      }
      hh.pop();
      return hh;
    };
    const hull = [...half(all), ...half(all.slice().reverse())];
    g.raw(
      `<path d="${g.d2(hull, true)}" fill="${T.t2}" stroke="${g.LINE}" stroke-width="1" stroke-linejoin="round" ${SW}/>`
    );
    g.raw(`<path d="${g.d2(top, true)}" fill="#fff" stroke="${g.LINE}" stroke-width="1" ${SW}/>`);
    g.raw(
      `<path d="${g.d2(ring(r * 0.74, 1 + h), true)}" fill="none" stroke="${g.LINE}" stroke-width="1" ${SW}/>`
    );
    /* the $ set in the face's plane: across along x, down the slope along v */
    const o = g.P(cx, cy + 4.8 * v[1] + (1 + h) * n[1], cz + 4.8 * v[2] + (1 + h) * n[2]);
    const O = g.P(0, 0, 0);
    const ax = g.P(1, 0, 0);
    const ay = g.P(0, v[1], v[2]);
    const m = [ax[0] - O[0], ax[1] - O[1], ay[0] - O[0], ay[1] - O[1]].map(
      (q) => Math.round(q * 1000) / 1000
    );
    g.raw(
      `<text transform="matrix(${m.join(",")},${o[0].toFixed(2)},${o[1].toFixed(2)})" font-family="${attr(g.SANS)}" font-size="14" font-weight="500" fill="${INK}" text-anchor="middle" text-rendering="geometricPrecision">$</text>`
    );
  };
  const up = g.along(
    [
      [xm, ys, zAt(ys)],
      [xm, ye, zAt(ye)],
    ],
    140,
    1040,
    { fadeOut: 0.18 }
  );
  const back: Key[] = [
    [1260, { o: 0, d: [0, 0, 10] }, "out"],
    [1640, {}],
  ];
  g.move("coin", [...up.frames, ...back], () => tilted(xm, ys, 18, 5));

  /* the card at the foot */
  const K = { x: 30, y: 134, w: 128, d: 80 };
  g.shadow(rrect(K.x, K.y, K.w, K.d, 9), { dx: 8, dy: 8, op: 0.07 });
  g.move(
    "tap",
    [
      [0, {}, "out"],
      [90, { d: [0, 0, -2] }, "inOut"],
      [260, {}],
    ],
    () => {
      const c = g.panel(K.x, K.y, 0, K.w, K.d, { h: 3, r: 9, shadow: false });
      g.flat(rrect(K.x + 16, K.y + 16, 20, 16, 3), c, { fill: T.t2 });
      g.text("**** 4242", K.x + 16, K.y + 60, c);
      g.text("VISA", K.x + K.w - 16, K.y + 60, c, { size: 10.5, fill: T.t5, anchor: "end" });
    }
  );
  return g.svg();
}
