/* FIG_005 Micro. An agent paying an API by the call: the API card with the call, its price and
   the calls paid so far; the agent's wallet at its side, a straight wire between them.
   Motion: four calls in an even rhythm, then a breath. For each a short pulse of ink runs along
   the wire, the wallet's balance goes down a thousandth as it leaves, and as it arrives the price
   lights green while the calls paid go up by one. */
import { attr, INK, type Key, makeFig, T } from "../make-fig";
import type { SceneInput } from "../scene-input";

export function microScene({ fonts, label, copy }: SceneInput): string {
  const CALLS = [0, 650, 1300, 1950];
  const RUN = 380;
  const g = makeFig({ ox: 318, oy: 258, id: "mic", cycle: 3000, label, fonts });
  const w = copy.words;
  g.grid({ cx: 0, cy: 0 });
  const PAD = 16;
  const GREEN = "#0E9F65";

  /* the agent wallet, and the API */
  const A = { x: -250, y: -37, w: 116, d: 74 };
  const B = { x: A.x + A.w + 149, y: -82, w: 200, d: 164 };
  const leave = CALLS.join(",");
  const land = CALLS.map((c) => c + RUN).join(",");

  /* the wire, and over it the pulse: a short dash of heavier ink run along it once per call */
  g.wire([
    [A.x + A.w, 0],
    [B.x, 0],
  ]);
  const LEN = 0.3;
  g.raw(
    `<path class="mic-pulse" d="${g.d2([g.P(A.x + A.w, 0, 0), g.P(B.x, 0, 0)])}" pathLength="1" stroke-dasharray="${LEN} 2" stroke-dashoffset="${LEN}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round" opacity="0"/>`
  );
  const pulse: Key[] = [];
  for (const c of CALLS) {
    pulse.push(
      [c, { x: `stroke-dashoffset:${LEN}` }, "inOut"],
      [c + RUN, { x: "stroke-dashoffset:-1" }],
      [c + RUN + 1, { x: `stroke-dashoffset:${LEN}` }]
    );
  }
  g.keys("pulse", pulse, { o: 0, x: `stroke-dashoffset:${LEN}` });

  /* the agent's wallet: its balance goes down a thousandth with every call; tabular figures, so
     a changing digit never pushes the words after it */
  const TAB = 'style="font-variant-numeric:tabular-nums"';
  let t = g.panel(A.x, A.y, 0, A.w, A.d, { heading: w.agentWallet });
  g.amount(copy.number(4.2, 3), A.x + PAD, A.y + 58, t, {
    size: 19,
    attrs: `${TAB} data-n="4.2" data-step="-0.001" data-dec="3" data-at="${leave}"`,
  });
  g.text("USDC", A.x + PAD + g.measure(copy.number(0, 3), { size: 19 }) + 6, A.y + 58, t, {
    size: 10,
    fill: T.t5,
  });

  /* the API: its calls paid go up by one with every arrival */
  t = g.panel(B.x, B.y, 0, B.w, B.d, { heading: w.api });
  g.text("GET /v1/quote", B.x + PAD, B.y + 52, t);
  /* the price lights green as a call arrives and goes back to ink */
  g.amount("$0.001", B.x + PAD, B.y + 98, t, { size: 34, cls: "mic-price" });
  const lit: Key[] = [];
  for (const c of CALLS) {
    const a = c + RUN;
    lit.push(
      [a - 20, { x: `fill:${INK}` }, "out"],
      [a + 90, { x: `fill:${GREEN}` }],
      [a + 320, { x: `fill:${GREEN}` }, "inOut"],
      [a + 560, { x: `fill:${INK}` }]
    );
  }
  g.keys("price", lit, { x: `fill:${INK}` });
  g.text(w.perCall, B.x + PAD + g.measure("$0.001", { size: 34 }) + 8, B.y + 98, t, {
    size: 10.5,
    fill: T.t5,
  });
  g.line([B.x, B.y + 118, t], [B.x + B.w, B.y + 118, t], { op: 0.25 });
  const sy = B.y + 145;
  /* the dot is grey at rest and lights green only as a call is paid */
  const [dx, dy, dr] = g.status(
    `${copy.number(12480)} ${w.callsPaid}`,
    B.x + PAD,
    sy,
    t,
    T.t4,
    INK,
    12.5,
    {
      attrs: `${TAB} data-n="12480" data-unit=" ${attr(w.callsPaid)}" data-at="${land}"`,
    }
  );
  const lamp: Key[] = [];
  for (const c of CALLS) {
    const a = c + RUN;
    lamp.push([a - 20, { o: 0 }, "out"], [a + 90, {}], [a + 320, {}, "inOut"], [a + 560, { o: 0 }]);
  }
  g.move("lamp", lamp, () => g.dot(dx, dy, t, dr, g.ACCENT), { rest: { o: 0 }, hidden: true });
  return g.svg();
}
