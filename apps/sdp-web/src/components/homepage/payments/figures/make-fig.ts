/*
 * The isometric kit: line drawings of the payment kinds, written out as SVG markup.
 *
 * Everything is drawn as hairlines (1px at any scale, non-scaling stroke), white tops, pale grey
 * sides, soft ground shadows and a dashed floor grid that fades out. The viewer looks from
 * +x +y +z, so larger x + y is nearer.
 *
 * Motion: a figure is still at rest and plays one cycle while `.live` is on its svg. Every
 * moving part runs on that one timeline, and every track starts and ends on the rest pose, so
 * taking `.live` off never makes anything jump. The keyframes go in the svg's own `<style>`,
 * every selector prefixed with the figure's id.
 */
import {
  ACCENT,
  area,
  bezier,
  circ,
  cubicBezier,
  type Ease,
  faces,
  INK,
  LINE,
  mix,
  type Pt,
  r2,
  rounded,
  rrect,
  T,
  thick,
} from "./geometry";

/** The faces the figure is set in, as the page resolves them (the app's fonts have hashed names). */
export type FigFonts = { sans: string; mono: string };

/** One keyframe: a move in plan units, a scale, an opacity, extra declarations. */
export type Frame = { d?: number[]; s?: number; sy?: number; o?: number; x?: string };
export type Key = [ms: number, frame?: Frame, ease?: Ease];

type Stroke = {
  cls?: string;
  fill?: string;
  stroke?: string;
  sw?: number;
  dash?: string;
  op?: number | string;
  open?: boolean;
  close?: boolean;
  arrow?: boolean;
  z?: number;
  r?: number;
};

type Solid = {
  top?: string;
  left?: string;
  right?: string;
  stroke?: string;
  fo?: number;
  holes?: Pt[][];
  depth?: number;
  floor?: string;
  inner?: string;
  r?: number;
  n?: number;
};

type TextStyle = {
  cls?: string;
  font?: string;
  size?: number;
  ls?: string;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  attrs?: string;
  weight?: number;
  op?: number;
};

type LabelStyle = Omit<TextStyle, "ls"> & { ls?: number };

type MoveOptions = {
  rest?: Frame;
  origin?: string;
  hidden?: boolean;
  when?: string;
  cls?: string;
};

type FigOptions = {
  w?: number;
  h?: number;
  ox?: number;
  oy?: number;
  k?: number;
  id: string;
  label: string;
  cycle: number;
  variants?: number;
  fonts: FigFonts;
};

const C = Math.cos(Math.PI / 6);
const S = 0.5;
/** Strokes keep their width however the figure is scaled. */
export const SW = 'vector-effect="non-scaling-stroke"';

/** Escapes a value for a double-quoted attribute. */
export const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let measureContext: CanvasRenderingContext2D | null | undefined;
function context2d(): CanvasRenderingContext2D | null {
  if (measureContext === undefined) {
    measureContext =
      typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  return measureContext;
}

export function makeFig({
  w = 640,
  h = 520,
  ox = 320,
  oy = 260,
  k = 1,
  id,
  label,
  cycle,
  variants = 1,
  fonts,
}: FigOptions) {
  const out: string[] = [];
  const css: string[] = [];
  const SANS = fonts.sans;
  const MONO = fonts.mono;
  const P = (x: number, y: number, z = 0): Pt => [ox + (x - y) * C * k, oy + ((x + y) * S - z) * k];
  const P3 = (p: Pt) => P(p[0], p[1], p[2] ?? 0);
  const pts = (a: Pt[]) => a.map((p) => `${r2(p[0])},${r2(p[1])}`).join(" ");
  const d2 = (a: Pt[], close?: boolean) =>
    `M${a.map((p) => `${r2(p[0])} ${r2(p[1])}`).join("L")}${close ? "Z" : ""}`;
  let clipN = 0;
  const emit = (s: string) => {
    out.push(s);
  };
  const strokeAttrs = (st: Stroke) =>
    `${st.cls ? `class="${st.cls}" ` : ""}fill="${st.fill || "none"}" stroke="${st.stroke || LINE}" stroke-width="${st.sw || 1}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""} stroke-linecap="round" stroke-linejoin="round" ${SW}${st.op ? ` opacity="${st.op}"` : ""}`;
  /* the screen offset of a move in plan units */
  const mv = (dx: number, dy: number, dz = 0) => [
    r2((dx - dy) * C * k),
    r2(((dx + dy) * S - dz) * k),
  ];

  function sideFaces(poly: Pt[], z0: number, top: number, st: Solid, fo: string): string {
    const n = poly.length;
    const { nrm, vis } = faces(poly);
    const L = st.left || T.t1;
    const R = st.right || T.t2;
    const g: string[] = [];
    const order = [...Array(n).keys()]
      .filter((i) => vis[i])
      .sort((i, j) => {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        const c = poly[j];
        const d = poly[(j + 1) % n];
        return a[0] + a[1] + b[0] + b[1] - (c[0] + c[1] + d[0] + d[1]);
      });
    for (const i of order) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const [nx, ny] = nrm[i];
      const fill = mix(L, R, Math.max(0, Math.min(1, (nx - ny + 1) / 2)));
      g.push(
        `<polygon points="${pts([P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], top), P(a[0], a[1], top)])}" fill="${fill}"${fo} stroke="${st.fo != null ? "none" : fill}" stroke-width=".6" ${SW}/>`
      );
    }
    let dd = "";
    for (let i = 0; i < n; i++) {
      if (!vis[i]) continue;
      const a = poly[i];
      const b = poly[(i + 1) % n];
      dd += d2([P(a[0], a[1], z0), P(b[0], b[1], z0)]);
    }
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      const v = poly[i];
      const crease = vis[p] && vis[i] && nrm[p][0] * nrm[i][0] + nrm[p][1] * nrm[i][1] < 0.94;
      if (vis[p] !== vis[i] || crease) dd += d2([P(v[0], v[1], z0), P(v[0], v[1], top)]);
    }
    g.push(
      `<path d="${dd}" fill="none" stroke="${st.stroke || LINE}" stroke-width="1" stroke-linecap="round" ${SW}/>`
    );
    return g.join("");
  }

  function hole(hp: Pt[], top: number, st: Solid, fo: string): string {
    const m = hp.length;
    const hc = area(hp) > 0;
    const cid = `${id}c${clipN++}`;
    const depth = st.depth || 0;
    const ink = st.stroke || LINE;
    const g: string[] = [];
    g.push(
      `<clipPath id="${cid}"><polygon points="${pts(hp.map((q) => P(q[0], q[1], top)))}"/></clipPath><g clip-path="url(#${cid})">`
    );
    g.push(
      `<polygon points="${pts(hp.map((q) => P(q[0], q[1], top - depth)))}" fill="${st.floor || T.t1}"${fo} stroke="${ink}" stroke-width="1" ${SW}/>`
    );
    for (let i = 0; i < m; i++) {
      const a = hp[i];
      const b = hp[(i + 1) % m];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      /* inward */
      const nx = -(hc ? dy : -dy) / l;
      const ny = -(hc ? -dx : dx) / l;
      if (nx + ny <= 1e-4) continue;
      const fill = mix(st.inner || T.t2, T.t3, Math.max(0, Math.min(1, (nx - ny + 1) / 2)));
      g.push(
        `<polygon points="${pts([P(a[0], a[1], top - depth), P(b[0], b[1], top - depth), P(b[0], b[1], top), P(a[0], a[1], top)])}" fill="${fill}"${fo} stroke="${st.fo != null ? "none" : fill}" stroke-width=".6" ${SW}/>`
      );
    }
    g.push("</g>");
    return g.join("");
  }

  /* a solid: a plan outline lifted from z0 by h, with optional holes */
  function prism(poly: Pt[], z0: number, height: number, st: Solid = {}) {
    const top = z0 + height;
    const fo = st.fo != null ? ` fill-opacity="${st.fo}"` : "";
    const g: string[] = [];
    if (height > 0) {
      g.push(sideFaces(poly, z0, top, st, fo));
      for (const hp of st.holes || [])
        g.push(hole(hp, top, { ...st, depth: st.depth || height }, fo));
    }
    const tp =
      d2(
        poly.map((q) => P(q[0], q[1], top)),
        true
      ) +
      (st.holes || []).map((hp) => d2(hp.map((q) => P(q[0], q[1], top)).reverse(), true)).join("");
    g.push(
      `<path d="${tp}" fill="${st.top || T.white}"${fo} fill-rule="evenodd" stroke="${st.stroke || LINE}" stroke-width="1" stroke-linejoin="round" ${SW}/>`
    );
    emit(g.join(""));
  }

  /* a keyframe track on the figure's timeline; the rest pose is filled in at 0 and at the end of
     the cycle. `when` ties a track to one variant (':not(.v1)' or '.v1'), and `cls` lets two
     tracks drive the same part */
  function keys(
    name: string,
    frames: Key[],
    rest: Frame = {},
    origin = "center",
    { when = "", cls = name }: { when?: string; cls?: string } = {}
  ) {
    const fr: Key[] = frames.slice().sort((a, b) => a[0] - b[0]);
    if (fr[0][0] > 0) fr.unshift([0, rest]);
    if (fr[fr.length - 1][0] < cycle) fr.push([cycle, rest]);
    /* a track that never moves or scales sets no transform at all, so it can go straight on an
       element that has a transform of its own (plane text) */
    const still = fr.every(([, f]) => !f || (!f.d && f.s == null && f.sy == null));
    const body = fr
      .map(([ms, f, e]) => {
        const p = f || {};
        const d = p.d || [0, 0, 0];
        const [dx, dy] = mv(d[0], d[1], d[2] ?? 0);
        /* never scale all the way to zero: a singular matrix on a hairline stops Chrome
           painting the whole figure */
        const s = Math.max(0.01, p.s ?? 1);
        const sy = Math.max(0.01, p.sy ?? s);
        const scale = s !== 1 || sy !== 1 ? ` scale(${r2(s)},${r2(sy)})` : "";
        let decl = `${still ? "" : `transform:translate(${dx}px,${dy}px)${scale};`}opacity:${r2(p.o ?? 1)}`;
        if (p.x) decl += `;${p.x}`;
        if (e) decl += `;animation-timing-function:${cubicBezier(e)}`;
        return `${Math.round((ms / cycle) * 1e5) / 1e3}%{${decl}}`;
      })
      .join("");
    css.push(`@keyframes ${id}-${name}{${body}}`);
    /* nor a transform origin: it would shift the element's own transform */
    css.push(
      `.live${when} .${id}-${cls}{animation:${id}-${name} ${cycle}ms linear both${still ? "" : `;transform-box:fill-box;transform-origin:${origin}`}}`
    );
  }

  function planeText(
    str: string,
    x: number,
    y: number,
    z: number,
    plane: "xy" | "xz" | "yz",
    st: TextStyle
  ) {
    const o = P(x, y, z);
    const font = st.font || MONO;
    const size = st.size || 10;
    /* optical left edge: a line set from its start begins where the ink of its first glyph
       begins, so a narrow J or 7 lines up with the dot under it */
    let tx = 0;
    const cx = (st.anchor || "middle") === "start" ? context2d() : null;
    if (cx) {
      cx.font = `${st.weight || 400} ${size}px ${font}`;
      tx = r2(cx.measureText(String(str)[0]).actualBoundingBoxLeft || 0);
    }
    const m = plane === "xy" ? [C, S, -C, S] : plane === "xz" ? [C, S, 0, 1] : [C, -S, 0, 1];
    emit(
      `<text${st.cls ? ` class="${st.cls}"` : ""} transform="matrix(${m.map((v) => r2(v * k)).join(",")},${r2(o[0])},${r2(o[1])})" font-family="${attr(font)}" font-size="${size}" letter-spacing="${st.ls || ".14em"}" fill="${st.fill || INK}" text-anchor="${st.anchor || "middle"}" text-rendering="geometricPrecision"${st.attrs ? ` ${st.attrs}` : ""}${tx ? ` x="${tx}"` : ""}${st.weight ? ` font-weight="${st.weight}"` : ""}${st.op ? ` opacity="${st.op}"` : ""}>${esc(str)}</text>`
    );
  }

  const api = {
    P,
    P3,
    d2,
    pts,
    INK,
    LINE,
    ACCENT,
    T,
    SANS,
    MONO,
    keys,
    raw: emit,
    prism,

    /* a part that moves: fn draws it at its rest pose, the group follows the track */
    move(name: string, frames: Key[], fn: () => void, o: MoveOptions = {}) {
      keys(name, frames, o.rest, o.origin, o);
      emit(`<g class="${id}-${name}"${o.hidden ? ' opacity="0"' : ""}>`);
      fn();
      emit("</g>");
    },

    /* frames that carry a part drawn at pts[0] along a plan path, eased as one run from t0 to
       t1 ms; at(j) is the time the part passes pts[j] */
    along(
      path: Pt[],
      t0: number,
      t1: number,
      {
        ease = "inOut" as Ease,
        n = 20,
        fadeIn = 0,
        fadeOut = 0,
      }: { ease?: Ease; n?: number; fadeIn?: number; fadeOut?: number } = {}
    ) {
      const L = [0];
      for (let i = 1; i < path.length; i++) {
        L.push(L[i - 1] + Math.hypot(...path[i].map((v, j) => v - path[i - 1][j])));
      }
      const tot = L[L.length - 1];
      const E = bezier(ease);
      const pos = (u: number) => {
        const s = u * tot;
        let i = 1;
        while (i < L.length - 1 && L[i] < s) i++;
        const a = path[i - 1];
        const b = path[i];
        const f = (s - L[i - 1]) / (L[i] - L[i - 1] || 1);
        return a.map((v, j) => v + (b[j] - v) * f - path[0][j]);
      };
      const frames: [number, Frame][] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const o = Math.min(1, fadeIn ? t / fadeIn : 1, fadeOut ? (1 - t) / fadeOut : 1);
        frames.push([t0 + (t1 - t0) * t, { d: pos(E(t)), o }]);
      }
      const at = (j: number) => {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 28; i++) {
          const m = (lo + hi) / 2;
          if (E(m) * tot < L[j]) lo = m;
          else hi = m;
        }
        return t0 + (t1 - t0) * lo;
      };
      return { frames, at };
    },

    /* the arrival: a green ring that leaves a dot and fades, once per time in ats */
    ping(
      name: string,
      x: number,
      y: number,
      z: number,
      r: number,
      ats: number | number[],
      len = 460,
      when = ""
    ) {
      const fr: Key[] = [];
      /* small dots ring out as far as big ones */
      const s = Math.max(r * 2.4, r + 8) / r;
      for (const a of ([] as number[]).concat(ats)) {
        fr.push(
          [a - 1, { o: 0 }],
          [a, { o: 0.9 }, "out"],
          [a + len * 0.45, { o: 0.55, s: 1 + (s - 1) * 0.8 }],
          [a + len, { o: 0, s }]
        );
      }
      api.move(name, fr, () => api.flat(circ(x, y, r, 48), z, { stroke: ACCENT }), {
        rest: { o: 0 },
        hidden: true,
        when,
      });
    },

    cyl: (cx: number, cy: number, r: number, z: number, height: number, st?: Solid) =>
      prism(circ(cx, cy, r, st?.n || 72), z, height, st),

    /* a soft shadow on the ground under a plan outline, thrown a little forward */
    shadow(poly: Pt[], st: { dx?: number; dy?: number; z?: number; op?: number } = {}) {
      const dx = st.dx ?? 10;
      const dy = st.dy ?? 10;
      const z = st.z || 0;
      emit(
        `<path d="${d2(
          poly.map((q) => P(q[0] + dx, q[1] + dy, z)),
          true
        )}" fill="${INK}" opacity="${st.op || 0.07}" filter="url(#${id}-soft)"/>`
      );
    },

    /* the dashed floor grid, fading out from its middle */
    grid(st: { step?: number; n?: number; cx?: number; cy?: number; op?: number } = {}) {
      const step = st.step || 40;
      const n = st.n || 9;
      const cx = st.cx || 0;
      const cy = st.cy || 0;
      const L = n * step;
      let dd = "";
      for (let i = -n; i <= n; i++) {
        dd += d2([P(cx + i * step, cy - L), P(cx + i * step, cy + L)]);
        dd += d2([P(cx - L, cy + i * step), P(cx + L, cy + i * step)]);
      }
      emit(
        `<path d="${dd}" fill="none" stroke="${INK}" stroke-width="1" stroke-dasharray="3 5" opacity="${st.op || 0.14}" mask="url(#${id}-fade)" ${SW}/>`
      );
    },

    flat(poly: Pt[], z: number, st: Stroke = {}) {
      emit(
        `<path d="${d2(
          poly.map((q) => P(q[0], q[1], z)),
          !st.open
        )}" ${strokeAttrs(st)}/>`
      );
    },

    line(a: Pt, b: Pt, st: Stroke = {}) {
      const A = P3(a);
      const B = P3(b);
      emit(`<path d="${d2([A, B])}" ${strokeAttrs(st)}/>`);
      if (st.arrow) api.head(B, A, 6, st.stroke);
    },

    /* a wire on the ground (or at height z) with eased corners */
    wire(plan: Pt[], st: Stroke = {}) {
      const z = st.z || 0;
      const path = rounded(plan, st.r || 16);
      emit(`<path d="${d2(path.map((q) => P(q[0], q[1], z)))}" ${strokeAttrs(st)}/>`);
      if (st.arrow) {
        const a = path[path.length - 2];
        const b = path[path.length - 1];
        api.head(P(b[0], b[1], z), P(a[0], a[1], z), 6, st.stroke);
      }
    },

    /* a filled disc lying flat */
    dot(x: number, y: number, z: number, r: number, fill = INK) {
      emit(
        `<path d="${d2(
          circ(x, y, r, 28).map((q) => P(q[0], q[1], z)),
          true
        )}" fill="${fill}"/>`
      );
    },

    /* a small filled arrowhead at B, pointing away from A (screen space) */
    head(B: Pt, A: Pt, s = 6, fill = INK) {
      const dx = B[0] - A[0];
      const dy = B[1] - A[1];
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l;
      const uy = dy / l;
      const p1 = [B[0] - ux * s - uy * s * 0.42, B[1] - uy * s + ux * s * 0.42];
      const p2 = [B[0] - ux * s + uy * s * 0.42, B[1] - uy * s - ux * s * 0.42];
      emit(`<polygon points="${pts([B, p1, p2])}" fill="${fill}"/>`);
    },

    planeText,

    /* a coin lying flat: a short cylinder with a rim line on its face */
    coin(cx: number, cy: number, z: number, r: number, height = 6) {
      api.cyl(cx, cy, r, z, height);
      api.flat(circ(cx, cy, r * 0.74, 64), z + height, { stroke: LINE });
    },

    /* a card of the product's interface lying flat: a thin slab with its heading at the left of
       its header, over a rule. Text reads along +x, rows run down +y */
    panel(
      x: number,
      y: number,
      z: number,
      w: number,
      d: number,
      o: { h?: number; r?: number; top?: string; shadow?: boolean; heading?: string } = {}
    ) {
      const height = o.h || 5;
      const poly = rrect(x, y, w, d, o.r || 10);
      if (o.shadow !== false) {
        api.shadow(poly, { dx: 8 + z * 0.25, dy: 8 + z * 0.25, op: z ? 0.05 : 0.07 });
      }
      prism(poly, z, height, { top: o.top || T.white });
      const t = z + height;
      if (o.heading != null) {
        if (o.heading)
          api.text(o.heading, x + 16, y + 17.2, t, { size: 10.5, fill: T.t5, ls: "0" });
        api.line([x, y + 27, t], [x + w, y + 27, t], { op: 0.25 });
      }
      return t;
    },

    /* mono text lying on the ground plane, set from its start */
    text(str: string, x: number, y: number, z: number, st: TextStyle = {}) {
      planeText(str, x, y, z, "xy", { anchor: "start", size: 11, ls: ".04em", weight: 500, ...st });
    },

    /* the set width of a line of text in plan units, measured by the browser (an estimate where
       there is no canvas) */
    measure(str: string, st: { size?: number; weight?: number; font?: string } = {}) {
      const size = st.size || 12.5;
      const cx = context2d();
      if (!cx) return String(str).length * size * 0.55;
      cx.font = `${st.weight || 500} ${size}px ${st.font || SANS}`;
      return cx.measureText(String(str)).width;
    },

    /* body text in the brand face, as the product sets names and states */
    sans(str: string, x: number, y: number, z: number, st: TextStyle = {}) {
      planeText(str, x, y, z, "xy", {
        anchor: "start",
        size: 12.5,
        ls: "0",
        weight: 500,
        font: SANS,
        ...st,
      });
    },

    /* a figure in the display face, as the product sets amounts */
    amount(str: string, x: number, y: number, z: number, st: TextStyle = {}) {
      planeText(str, x, y, z, "xy", { anchor: "start", size: 22, ls: "-.01em", font: SANS, ...st });
    },

    /* mono text centred on a point of the ground plane, both ways; the letter spacing that SVG
       adds after the last glyph is paid back */
    label(str: string, x: number, y: number, z: number, st: LabelStyle = {}) {
      const size = st.size || 9;
      const ls = st.ls ?? 0.14;
      planeText(str, x + (size * ls) / 2, y + size * 0.36, z, "xy", {
        ...st,
        anchor: "middle",
        ls: `${ls}em`,
        size,
      });
    },

    /* a status: a dot and a word; returns the dot's centre and radius */
    status(
      str: string,
      x: number,
      y: number,
      z: number,
      dot = ACCENT,
      fill = INK,
      size = 12.5,
      st: TextStyle = {}
    ): [number, number, number] {
      const r = size * 0.27;
      api.dot(x + r, y - size * 0.32, z, r, dot);
      api.sans(str, x + r * 2 + 6, y, z, { fill, size, ...st });
      return [x + r, y - size * 0.32, r];
    },

    /* a tick lying flat in the same frame as the text beside it, centred on (cx, cy) */
    tick(cx: number, cy: number, z: number, s = 1, fill = INK, w = 1.6) {
      const uv = ([X, Y]: Pt): Pt => [cx + (X - 0.1) * s, cy - (Y - 0.7) * s];
      api.flat(
        thick(
          [
            [-4.4, 0.6],
            [-1.4, -2.6],
            [4.6, 4],
          ].map(uv),
          w * s
        ),
        z,
        { fill, stroke: "none" }
      );
    },

    /* the description goes in aria-label, not a <title>: a <title> shows as a tooltip */
    svg() {
      const style = css.length
        ? `<style>${css.join("\n")}\n@media (prefers-reduced-motion:reduce){.live [class^="${id}-"]{animation:none!important}}</style>`
        : "";
      return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" data-cycle="${cycle}"${variants > 1 ? ` data-variants="${variants}"` : ""} aria-label="${attr(label)}">
${style}
<defs>
  <filter id="${id}-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
  <radialGradient id="${id}-fg" cx="${ox}" cy="${oy}" r="${Math.max(w, h) * 0.52}" gradientUnits="userSpaceOnUse"><stop offset=".25" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
  <mask id="${id}-fade" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="url(#${id}-fg)"/></mask>
</defs>
${out.join("\n")}
</svg>`;
    },
  };
  return api;
}

export { ACCENT, circ, INK, rrect, T };
