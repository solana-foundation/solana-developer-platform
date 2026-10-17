/* FIG_001 Pay. The source wallet feeds the Pay card (the contact, the amount, Send); the payment
   passes the policy and goes on to the contact's wallet in USDC, or branches off through a
   provider to their bank.
   Motion: Send is pressed and the amount lifts out of the button as a chip; it arcs over the
   policy puck (its tick turns green with the arrival's dot), its shadow running on the floor
   below, and settles into Jane's wallet, which gives under it. The next time round the same chip
   goes to the bank instead and turns from USDC into USD over the puck: the off-ramp. */
import { cubicPath, type Pt } from "../geometry";
import { type Frame, INK, type Key, makeFig, rrect, T } from "../make-fig";
import type { SceneInput } from "../scene-input";

type Route = {
  when: string;
  end: Pt;
  frames: [number, Frame][];
  over: number;
  shadow: Key[];
};

export function payScene({ fonts, label, copy }: SceneInput): string {
  const g = makeFig({ ox: 300, oy: 214, id: "pay", cycle: 2000, variants: 2, label, fonts });
  const w = copy.words;
  g.grid({ cx: 0, cy: 40 });
  const GAP = 24;
  const PAD = 16;

  /* Pay, the subject */
  const B = { x: -104, y: -82, w: 200, d: 164 };
  /* the source wallet */
  const A = { w: 116, d: 74, x: B.x - GAP - 116, y: -74 / 2 };
  /* the policy puck */
  const PR = 13;
  const PX = B.x + B.w + GAP + PR;
  /* the contact's wallet, and their bank */
  const J = { x: PX + PR + GAP, y: -39, w: 122, d: 78 };
  const K = { x: J.x, y: J.y + J.d + 48, w: 122, d: 78 };
  /* the Send button */
  const by = B.y + 118;
  const bw = B.w - PAD * 2;

  /* the flight: the chip leaves the Pay card on its right edge, rising as it goes, glides over
     the puck and comes straight down onto the card it lands in; its shadow follows on the
     floor, thrown further and paler the higher the chip is */
  const CW = 86;
  const CD = 22;
  const CH = 3;
  const Z0 = 5;
  const PEAK = 64;
  const LIFT = 92;
  const start = [B.x + B.w - 8, 0, Z0 + 4];
  const T0 = 160;
  const T1 = 1120;
  const LAND = T1 - 40;
  /* late in the cycle the greens ease back to rest */
  const BACK = 1640;
  const HOME = 1960;

  const route = (when: string, end: Pt): Route => {
    const c1 = [start[0] + 22, 0, Z0 + LIFT];
    const c2 = [end[0], end[1], Z0 + LIFT];
    const pts = cubicPath(start, c1, c2, end);
    const run = g.along(pts, T0, T1, { fadeIn: 0.12, fadeOut: 0.1, n: 32 });
    run.frames[0][1].s = 0.7;
    run.frames[1][1].s = 0.9;
    /* the moment the chip is nearest the puck, seen from above */
    const off = (p: Pt) => Math.hypot(p[0] - PX, p[1]);
    let jn = 0;
    pts.forEach((p, j) => {
      if (off(p) < off(pts[jn])) jn = j;
    });
    const shadow: Key[] = run.frames.map(([ms, f]) => {
      const d = f.d ?? [0, 0, 0];
      return [
        ms,
        {
          d: [d[0] + d[2] * 0.35, d[1] + d[2] * 0.35, 0],
          o: (f.o ?? 1) * Math.max(0, 1 - d[2] / (PEAK * 1.1)),
        },
      ];
    });
    return { when, end, frames: run.frames, over: run.at(jn), shadow };
  };
  const routes = {
    w: route(":not(.v1)", [J.x + J.w / 2, J.y + J.d / 2 + 6, Z0]),
    b: route(".v1", [K.x + K.w / 2, K.y + K.d / 2 + 6, Z0]),
  };
  const both = Object.entries(routes);

  /* the wires */
  g.wire([
    [A.x + A.w, 0],
    [B.x, 0],
  ]);
  g.wire([
    [B.x + B.w, 0],
    [PX - PR, 0],
  ]);
  g.wire([
    [PX + PR, 0],
    [J.x, 0],
  ]);
  g.wire(
    [
      [PX, PR],
      [PX, K.y + K.d / 2],
      [K.x, K.y + K.d / 2],
    ],
    { r: 18 }
  );

  /* the chip's shadow on the floor, under every card it passes */
  for (const [key, r] of both) {
    g.keys(`sh${key}`, r.shadow, { o: 0 }, "center", { when: r.when, cls: "sh" });
  }
  g.raw('<g class="pay-sh" opacity="0">');
  g.shadow(rrect(start[0] - CW / 2, start[1] - CD / 2, CW, CD, CD / 2), { dx: 0, dy: 0, op: 0.12 });
  g.raw("</g>");

  /* the source wallet */
  let t = g.panel(A.x, A.y, 0, A.w, A.d, { heading: w.opsWallet });
  const balance = copy.number(12480, 0);
  g.amount(balance, A.x + PAD, A.y + 58, t, { size: 19 });
  g.text("USDC", A.x + PAD + g.measure(balance, { size: 19 }) + 5, A.y + 58, t, {
    size: 10,
    fill: T.t5,
  });

  /* the Pay card */
  t = g.panel(B.x, B.y, 0, B.w, B.d, { heading: w.pay });
  g.sans("Jane Smith", B.x + PAD, B.y + 56, t, { size: 14 });
  const payAmount = copy.number(250, 2);
  g.amount(payAmount, B.x + PAD, B.y + 102, t, { size: 34 });
  g.text("USDC", B.x + PAD + g.measure(payAmount, { size: 34 }) + 7, B.y + 102, t, {
    size: 10.5,
    fill: T.t5,
  });
  const sendT = t;
  g.move(
    "send",
    [
      [0, {}, "out"],
      [80, { d: [0, 0, -2] }, "inOut"],
      [260, {}],
    ],
    () => {
      /* outlined, not filled: a shade darker than the card's edge */
      g.flat(rrect(B.x + PAD, by, bw, 30, 15), sendT, { fill: T.white, stroke: "#BDBBC3" });
      g.label(w.send, B.x + PAD + bw / 2, by + 15, sendT, {
        size: 11.5,
        fill: INK,
        weight: 500,
        ls: 0.18,
      });
    }
  );

  /* the policy: a puck the payment passes over, ticked; when the payment lands the tick turns
     from ink to green together with the status dot of the card it lands in */
  g.shadow(rrect(PX - PR, -PR, PR * 2, PR * 2, PR), { dx: 4, dy: 4, op: 0.06 });
  g.cyl(PX, 0, PR, 0, 6, { n: 64 });
  for (const [key, r] of both) {
    g.keys(
      `ink${key}`,
      [
        [LAND + 40, {}, "out"],
        [LAND + 240, { o: 0 }],
        [BACK, { o: 0 }, "inOut"],
        [HOME, {}],
      ],
      {},
      "center",
      { when: r.when, cls: "ink" }
    );
    g.keys(
      `wht${key}`,
      [
        [LAND + 40, { o: 0 }, "out"],
        [LAND + 240, { o: 1 }],
        [BACK, { o: 1 }, "inOut"],
        [HOME, { o: 0 }],
      ],
      { o: 0 },
      "center",
      { when: r.when, cls: "wht" }
    );
    g.ping(`pp${key}`, PX, 0, 6, PR, LAND + 60, 520, r.when);
  }
  g.raw('<g class="pay-ink">');
  g.tick(PX, 0, 6, 1.25);
  g.raw("</g>");
  g.raw('<g class="pay-wht" opacity="0">');
  g.tick(PX, 0, 6, 1.25, g.ACCENT);
  g.raw("</g>");

  /* a status dot is grey until the payment lands in its card; then it turns green with a ping,
     and eases back to grey late in the cycle */
  const lit = (name: string, x: number, y: number, z: number, r: number, when: string) => {
    g.move(
      name,
      [
        [LAND + 40, { o: 0 }, "out"],
        [LAND + 240, { o: 1 }],
        [BACK, { o: 1 }, "inOut"],
        [HOME, { o: 0 }],
      ],
      () => g.dot(x, y, z, r, g.ACCENT),
      { rest: { o: 0 }, hidden: true, when }
    );
    g.ping(`${name}p`, x, y, z, r, LAND + 60, 520, when);
  };

  /* a card that takes the payment gives a little under it */
  const give: Key[] = [
    [LAND - 20, {}, "out"],
    [LAND + 90, { d: [0, 0, -2] }, "inOut"],
    [LAND + 380, {}],
  ];

  /* the contact's wallet: the stablecoin lands here */
  g.move(
    "jw",
    give,
    () => {
      const z = g.panel(J.x, J.y, 0, J.w, J.d, { heading: "Jane Smith" });
      g.text("7xKX...9fQa", J.x + PAD, J.y + 47, z, { size: 10.5 });
      const [x, y, r] = g.status(w.received, J.x + PAD, J.y + 64, z, T.t4, INK, 11.5);
      lit("jg", x, y, z, r, routes.w.when);
    },
    { when: routes.w.when }
  );

  /* or out to fiat, through a provider, to her bank */
  g.move(
    "kb",
    give,
    () => {
      const z = g.panel(K.x, K.y, 0, K.w, K.d, { heading: w.bankUsd });
      g.text("**** 4021", K.x + PAD, K.y + 47, z, { size: 10.5 });
      const [x, y, r] = g.status(w.paidOut, K.x + PAD, K.y + 64, z, T.t4, INK, 11.5);
      lit("kg", x, y, z, r, routes.b.when);
    },
    { when: routes.b.when }
  );

  /* the payment, in flight above everything: a pill with the amount, drawn at the card's edge
     and carried along its route */
  for (const [key, r] of both) {
    g.keys(`chip${key}`, r.frames, { o: 0 }, "center", { when: r.when, cls: "chip" });
  }
  const cx = start[0] - CW / 2;
  const cy = start[1] - CD / 2;
  g.raw('<g class="pay-chip" opacity="0">');
  const ct = g.panel(cx, cy, start[2], CW, CD, { h: CH, r: CD / 2, shadow: false });
  const amt = copy.number(250, 2);
  const ux = cx + 12 + g.measure(amt, { size: 12 }) + 5;
  const uy = start[1] + 4.2;
  g.sans(amt, cx + 12, uy, ct, { size: 12 });
  /* the unit: USDC all the way to the wallet; on the way to the bank it turns to USD as it
     passes the provider over the puck */
  const sw = routes.b.over;
  const turn = (a: number, b: number): Key[] => [
    [sw - 80, { o: a }, "inOut"],
    [sw + 80, { o: b }],
    [T1 + 20, { o: b }],
  ];
  g.keys("usdc", turn(1, 0), {}, "center", { when: ".v1", cls: "usdc" });
  g.keys("usd", turn(0, 1), { o: 0 }, "center", { when: ".v1", cls: "usd" });
  g.raw('<g class="pay-usdc">');
  g.text("USDC", ux, uy, ct, { size: 10, fill: T.t5 });
  g.raw("</g>");
  g.raw('<g class="pay-usd" opacity="0">');
  g.text("USD", ux, uy, ct, { size: 10, fill: T.t5 });
  g.raw("</g>");
  g.raw("</g>");
  return g.svg();
}
