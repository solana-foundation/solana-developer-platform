/* FIG_002 Request. A card with the amount and the wallet it is paid into, and below a rule the
   track to finality. From the card one wire runs to a T and splits to the two ways the product
   shares a request: a QR code and its link.
   Motion: the request opens again (the stops go out, awaiting payment); the payer scans the code
   and the payment rises out of it, arcs back and settles into the request, which gives under
   it; then the track runs from Processed through Confirmed to Finalized, Finalized in green with
   a ping. The next time round the link is used instead: a click on its copy icon, and only then
   does the payment come out of the pill. */
import { cubicPath, type Pt } from "../geometry";
import { circ, type Frame, INK, type Key, makeFig, rrect, T } from "../make-fig";
import type { SceneInput } from "../scene-input";

/*
 * A picture of a QR code, not one: the three finder squares are real, every other module comes
 * from a fixed pseudo-random fill, so no reader can decode it (and it can never point anywhere).
 * Both copies of the format information, read either way round and inverted, are at least 4 bits
 * from every valid format word (readers correct up to 3), the timing rows do not alternate, and
 * the data modules carry no valid Reed-Solomon codewords.
 */
const QR = [
  "111111101011101111111",
  "100000100101101000001",
  "101110101101101011101",
  "101110101100001011101",
  "101110101001001011101",
  "100000101010001000001",
  "111111100000101111111",
  "000000000101000000000",
  "011010011111101101111",
  "101010101100110001000",
  "011101010110000101010",
  "001100000010001010011",
  "111000000100110100111",
  "000000001101000011001",
  "111111101101010011100",
  "100000101000011111010",
  "101110100010100110010",
  "101110100111100011111",
  "101110100100111010011",
  "100000100010011101100",
  "111111101011001001100",
];

type Route = { when: string; start: Pt; frames: [number, Frame][]; shadow: Key[] };

export function requestScene({ fonts, label, copy }: SceneInput): string {
  const g = makeFig({ ox: 322, oy: 274, id: "req", cycle: 2700, variants: 2, label, fonts });
  const w = copy.words;
  g.grid({ cx: 0, cy: 0 });
  const PAD = 16;
  const GAP = 24;
  const R = { x: -236, y: -94, w: 236, d: 188 };
  const JX = R.x + R.w + GAP + 6;
  const Q = { x: JX + GAP + 6, y: -160, w: 104, d: 104 };
  const L = { x: Q.x, y: 40, w: 248, d: 32 };

  /* the timeline: the request opens again, the payment flies in from F0 to F1 and lands, then
     the track runs from T0 to T1 */
  const OPEN = 220;
  const F0 = 560;
  const F1 = 1260;
  const LAND = F1 - 40;
  const T0 = 1320;
  const T1 = 2100;
  const TM = (T0 + T1) / 2;

  /* the flight: straight up out of the code or the link, over, and straight down onto the
     request, in the clear space right of its address */
  const CW = 86;
  const CD = 22;
  const LIFT = 84;
  const end = [R.x + R.w - 60, R.y + 96, 5];
  const route = (when: string, s: Pt): Route => {
    const pts = cubicPath(s, [s[0], s[1], s[2] + LIFT], [end[0], end[1], end[2] + LIFT], end);
    const run = g.along(pts, F0, F1, { fadeIn: 0.12, fadeOut: 0.1, n: 32 });
    run.frames[0][1].s = 0.7;
    run.frames[1][1].s = 0.9;
    const shadow: Key[] = run.frames.map(([ms, f]) => {
      const d = f.d ?? [0, 0, 0];
      return [
        ms,
        {
          d: [d[0] + d[2] * 0.35, d[1] + d[2] * 0.35, 0],
          o: (f.o ?? 1) * Math.max(0, 1 - d[2] / 70),
        },
      ];
    });
    return { when, start: s, frames: run.frames, shadow };
  };
  const routes = {
    q: route(":not(.v1)", [Q.x + Q.w / 2, Q.y + Q.d / 2, 9]),
    l: route(".v1", [L.x + L.w / 2 - 10, L.y + L.d / 2, 8]),
  };
  const both = Object.entries(routes);

  /* the wires: straight into a T, then up to the code and down to the link */
  const qy = Q.y + Q.d / 2;
  const ly = L.y + L.d / 2;
  g.wire([
    [R.x + R.w, 0],
    [JX, 0],
  ]);
  g.wire(
    [
      [JX, 0],
      [JX, qy],
      [Q.x, qy],
    ],
    { r: 18 }
  );
  g.wire(
    [
      [JX, 0],
      [JX, ly],
      [L.x, ly],
    ],
    { r: 14 }
  );
  g.dot(JX, 0, 0, 3.2);

  /* the chip's shadow on the floor */
  for (const [key, r] of both) {
    g.keys(`sh${key}`, r.shadow, { o: 0 }, "center", { when: r.when, cls: `sh${key}` });
  }
  for (const [key, r] of both) {
    g.raw(`<g class="req-sh${key}" opacity="0">`);
    g.shadow(rrect(r.start[0] - CW / 2, r.start[1] - CD / 2, CW, CD, CD / 2), {
      dx: 0,
      dy: 0,
      op: 0.12,
    });
    g.raw("</g>");
  }

  /* the request, giving a little as the payment lands in it */
  g.move(
    "card",
    [
      [LAND - 20, {}, "out"],
      [LAND + 90, { d: [0, 0, -1.5] }, "inOut"],
      [LAND + 380, {}],
    ],
    () => {
      const t = g.panel(R.x, R.y, 0, R.w, R.d, { heading: w.paymentRequest });
      const requested = copy.number(120, 2);
      g.amount(requested, R.x + PAD, R.y + 70, t, { size: 32 });
      g.text("USDC", R.x + PAD + g.measure(requested, { size: 32 }) + 7, R.y + 70, t, {
        size: 10.5,
        fill: T.t5,
      });
      g.text(copy.paidTo("7xKX...9fQa"), R.x + PAD, R.y + 94, t);

      /* below a rule, the track to finality: a pale line and hollow stops */
      const rule = R.y + 116;
      g.line([R.x, rule, t], [R.x + R.w, rule, t], { op: 0.25 });
      const ty = rule + 30;
      const x0 = R.x + PAD + 30;
      const x2 = R.x + R.w - PAD - 30;
      const xs = [x0, (x0 + x2) / 2, x2];
      g.line([x0, ty, t], [x2, ty, t], { op: 0.3 });
      /* a solid white disc under each hollow stop, so the track does not show through it */
      xs.forEach((x, i) => {
        const c = circ(x, ty, i === 2 ? 5.8 : 2.8, 32);
        g.flat(c, t, { fill: T.white, stroke: "none" });
        g.flat(c, t, { op: 0.5 });
      });

      /* the progress, drawn in ink over the pale track, gone again at rest */
      g.raw(
        `<path class="req-prog" d="${g.d2([g.P(x0, ty, t), g.P(x2, ty, t)])}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1" fill="none" stroke="${INK}" stroke-width="1.3" opacity="0"/>`
      );
      g.keys(
        "prog",
        [
          [T0, { o: 1, x: "stroke-dashoffset:1" }, "inOut"],
          [T1, { o: 1, x: "stroke-dashoffset:0" }],
          [T1 + 260, { o: 1, x: "stroke-dashoffset:0" }],
          [2660, { o: 0, x: "stroke-dashoffset:0" }],
        ],
        { o: 0, x: "stroke-dashoffset:1" }
      );

      /* the stops: out as the request opens, each lit again (only fading in) as it is reached */
      const lit = (at: number): Key[] => [
        [0, {}, "in"],
        [OPEN, { o: 0 }],
        [at - 40, { o: 0 }, "out"],
        [at + 140, {}],
      ];
      const names = [w.processed, w.confirmed, w.finalized];
      [T0, TM, T1].forEach((at, i) => {
        const x = xs[i];
        if (i === 2) {
          /* the last stop is the one to see: far larger than the two before it */
          g.ping("got", x, ty, t, 11, T1 + 60, 520);
          g.move("st2", lit(at), () => {
            g.dot(x, ty, t, 11, g.ACCENT);
            g.tick(x, ty, t, 1.2, "#fff", 2.4);
          });
        } else g.move(`st${i}`, lit(at), () => g.dot(x, ty, t, 3.4, INK));
        g.label(names[i], x, ty + 24, t, { size: 10, ls: 0.02, fill: i === 2 ? INK : T.t5 });
      });
    }
  );

  /* the QR code: square modules with no gaps, each row's runs in one path */
  const s = g.panel(Q.x, Q.y, 0, Q.w, Q.d, { r: 12 });
  const n = QR.length;
  const c = (Q.w - 20) / n;
  const qx0 = Q.x + 10;
  const qy0 = Q.y + 10;
  let qd = "";
  QR.forEach((row, i) => {
    for (const match of row.matchAll(/1+/g)) {
      const j = match.index ?? 0;
      const x = qx0 + j * c;
      const y = qy0 + i * c;
      const rw = match[0].length * c;
      const rh = c + 0.05;
      const corners: Pt[] = [
        [x, y],
        [x + rw, y],
        [x + rw, y + rh],
        [x, y + rh],
      ];
      qd += g.d2(
        corners.map(([a, b]) => g.P(a, b, s)),
        true
      );
    }
  });
  g.raw(`<path d="${qd}" fill="${INK}"/>`);
  /* the payer scans: a line passing down the code, over and gone */
  g.move(
    "scan",
    [
      [140, { o: 0 }],
      [200, { o: 1 }, "inOut"],
      [520, { o: 1, d: [0, n * c, 0] }],
      [580, { o: 0, d: [0, n * c, 0] }],
    ],
    () => g.line([qx0 - 5, qy0, s], [qx0 + n * c + 5, qy0, s], {}),
    { hidden: true, rest: { o: 0 }, when: routes.q.when }
  );

  /* the link: a click on its copy icon first (the icon gives, a thin ring spreads from it), and
     only then does the payment come out of the pill */
  const l = g.panel(L.x, L.y, 0, L.w, L.d, { r: 16, h: 4 });
  /* the real shape of a request link (payment-requests-workspace.tsx: `${origin}/pay/${publicToken}`),
     its token left out */
  g.text("platform.solana.com/pay/…", L.x + PAD, L.y + L.d / 2 + 4, l);
  const ix = L.x + L.w - 28;
  const iy = L.y + 9;
  const icx = ix + 6.25;
  const icy = iy + 7.25;
  const CLICK = 260;
  g.move(
    "copy",
    [
      [CLICK, {}, "out"],
      [CLICK + 80, { d: [0, 0, -1.2] }, "inOut"],
      [CLICK + 260, {}],
    ],
    () => {
      g.flat(rrect(ix, iy, 9, 11, 2), l, {});
      g.flat(rrect(ix + 3.5, iy + 3.5, 9, 11, 2), l, { fill: T.white });
    },
    { when: routes.l.when }
  );
  g.move(
    "click",
    [
      [CLICK + 40, { o: 0 }],
      [CLICK + 60, { o: 1 }, "out"],
      [CLICK + 200, { o: 0.6, s: 1.8 }],
      [CLICK + 440, { o: 0, s: 2.4 }],
    ],
    () => g.flat(circ(icx, icy, 8, 40), l, {}),
    { rest: { o: 0 }, hidden: true, when: routes.l.when }
  );

  /* the payment, in flight above everything: drawn where it lands and carried in from wherever
     it starts */
  for (const [key, r] of both) {
    const fr: Key[] = r.frames.map(([ms, f]) => [
      ms,
      { ...f, d: (f.d ?? [0, 0, 0]).map((v, j) => v + r.start[j] - end[j]) },
    ]);
    g.keys(`chip${key}`, fr, { o: 0 }, "center", { when: r.when, cls: "chip" });
  }
  const cx = end[0] - CW / 2;
  const cy = end[1] - CD / 2;
  g.raw('<g class="req-chip" opacity="0">');
  const ct = g.panel(cx, cy, end[2], CW, CD, { h: 3, r: CD / 2, shadow: false });
  const amt = copy.number(120, 2);
  const uy = end[1] + 4.2;
  g.sans(amt, cx + 12, uy, ct, { size: 12 });
  g.text("USDC", cx + 12 + g.measure(amt, { size: 12 }) + 5, uy, ct, { size: 10, fill: T.t5 });
  g.raw("</g>");
  return g.svg();
}
