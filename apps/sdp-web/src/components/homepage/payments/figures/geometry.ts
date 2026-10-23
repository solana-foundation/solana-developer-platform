/*
 * The isometric kit's plan geometry.
 * Plan coordinates (x, y) lie on the ground, z goes up.
 */

/** A point: [x, y] on the plan, or [x, y, z]. */
export type Pt = number[];

export const INK = "#16161B";
/** The line: every outline, wire and leader; the full ink is kept for type and state dots. */
export const LINE = "#D4D2D9";
/** The green the landing uses for a confirmed payment. */
export const ACCENT = "#14C77F";
export const T = {
  white: "#FFFFFF",
  t1: "#F6F6F7",
  t2: "#ECECEE",
  t3: "#E1E1E4",
  t4: "#CDCDD2",
  t5: "#6A6973",
} as const;

export const r2 = (n: number) => Math.round(n * 100) / 100;

const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));

export function mix(a: string, b: string, k: number): string {
  const A = hex(a);
  const B = hex(b);
  return `#${A.map((v, i) =>
    Math.round(v + (B[i] - v) * k)
      .toString(16)
      .padStart(2, "0")
  ).join("")}`;
}

export function circ(cx: number, cy: number, r: number, n = 72, a0 = 0, a1 = Math.PI * 2): Pt[] {
  const out: Pt[] = [];
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
  const m = full ? n : n + 1;
  for (let i = 0; i < m; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

export function rrect(x: number, y: number, w: number, d: number, r = 0, seg = 8): Pt[] {
  if (!r) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + d],
      [x, y + d],
    ];
  }
  const out: Pt[] = [];
  const corners = [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + d - r, 0],
    [x + r, y + d - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ];
  for (const [cx, cy, a] of corners) {
    for (let i = 0; i <= seg; i++) {
      const t = a + ((Math.PI / 2) * i) / seg;
      out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  }
  /* where the radius is half the side two corners meet in one point; the repeat would make an
     edge of no length, which draws a false silhouette line down the side, so drop it */
  const same = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  const clean = out.filter((p, i) => i === 0 || !same(p, out[i - 1]));
  while (clean.length > 1 && same(clean[0], clean[clean.length - 1])) clean.pop();
  return clean;
}

/** A polyline with its corners eased into short curves. */
export function rounded(pts: Pt[], r = 14): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const A = pts[i - 1];
    const B = pts[i];
    const D = pts[i + 1];
    const la = Math.hypot(A[0] - B[0], A[1] - B[1]);
    const lc = Math.hypot(D[0] - B[0], D[1] - B[1]);
    const rr = Math.min(r, la / 2, lc / 2);
    const p1 = [B[0] + ((A[0] - B[0]) / la) * rr, B[1] + ((A[1] - B[1]) / la) * rr];
    const p2 = [B[0] + ((D[0] - B[0]) / lc) * rr, B[1] + ((D[1] - B[1]) / lc) * rr];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const u = 1 - t;
      out.push([
        u * u * p1[0] + 2 * u * t * B[0] + t * t * p2[0],
        u * u * p1[1] + 2 * u * t * B[1] + t * t * p2[1],
      ]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** A polyline widened into a closed outline, w wide, with mitred joints. */
export function thick(pts: Pt[], w: number): Pt[] {
  const n = pts.length;
  const hw = w / 2;
  const L: Pt[] = [];
  const R: Pt[] = [];
  const nrm = (a: Pt, b: Pt) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  for (let i = 0; i < n; i++) {
    const n1 = i > 0 ? nrm(pts[i - 1], pts[i]) : nrm(pts[0], pts[1]);
    const n2 = i < n - 1 ? nrm(pts[i], pts[i + 1]) : n1;
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const s = hw / Math.max(0.3, mx * n1[0] + my * n1[1]);
    L.push([pts[i][0] + mx * s, pts[i][1] + my * s]);
    R.push([pts[i][0] - mx * s, pts[i][1] - my * s]);
  }
  return [...L, ...R.reverse()];
}

export function area(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Each edge's outward normal, and whether the viewer (looking from +x +y +z) sees its face. */
export function faces(poly: Pt[]): { nrm: Pt[]; vis: boolean[] } {
  const n = poly.length;
  const ccw = area(poly) > 0;
  const nrm: Pt[] = [];
  const vis: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = (ccw ? dy : -dy) / l;
    const ny = (ccw ? -dx : dx) / l;
    nrm.push([nx, ny]);
    vis.push(nx + ny > 1e-4);
  }
  return { nrm, vis };
}

export type Ease = "out" | "inOut" | "in" | readonly [number, number, number, number];

const EASE = {
  out: [0.22, 1, 0.36, 1],
  inOut: [0.65, 0, 0.35, 1],
  in: [0.55, 0, 1, 0.45],
} as const;

const easeOf = (e: Ease) => (typeof e === "string" ? EASE[e] : e);

export const cubicBezier = (e: Ease) => `cubic-bezier(${easeOf(e).join(",")})`;

/** The easing curve as a function of progress, solved by bisection. */
export function bezier(e: Ease): (x: number) => number {
  const [x1, y1, x2, y2] = easeOf(e);
  const f = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
  return (x) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 28; i++) {
      const m = (lo + hi) / 2;
      if (f(x1, x2, m) < x) lo = m;
      else hi = m;
    }
    return f(y1, y2, (lo + hi) / 2);
  };
}

/** Points along a cubic Bézier between a and b, with control points c1 and c2. */
export function cubicPath(a: Pt, c1: Pt, c2: Pt, b: Pt, steps = 40): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const k0 = (1 - u) ** 3;
    const k1 = 3 * u * (1 - u) ** 2;
    const k2 = 3 * u * u * (1 - u);
    const k3 = u ** 3;
    pts.push(a.map((v, j) => k0 * v + k1 * c1[j] + k2 * c2[j] + k3 * b[j]));
  }
  return pts;
}
