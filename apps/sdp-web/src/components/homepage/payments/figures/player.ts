import { easeOutCubic } from "@/lib/easing";
import { formatNumber } from "@/lib/number-format";
import { reflow } from "../../restart-animation";

/*
 * One figure's motion, as one cycle with `.live` on the svg; counters, sequences and
 * tallies on the same clock; `.v1` on every other cycle for a figure with two outcomes.
 */

/** The rest between two cycles of one figure. */
const CYCLE_PAUSE = 900;

export type FigurePlayer = {
  /** How long the figure plays before it hands on: two cycles, or one per outcome. */
  dwell: number;
  readonly busy: boolean;
  start(): void;
  /** Let the cycle under way come back to rest, then stay there. */
  ease(): void;
  /** Back to rest at once: only for a figure nobody is looking at. */
  stop(): void;
};

type Counter = {
  el: Element;
  n: number;
  n0: number;
  step: number;
  dec: number;
  dur: number;
  max: number | null;
  at: number[];
  unit: string;
};

type Sequence = { el: Element; list: string[]; i: number; inc: number; at: number | null };

function dataOf(el: Element): DOMStringMap {
  return (el as HTMLElement | SVGElement).dataset;
}

export function createFigurePlayer(
  svg: SVGSVGElement,
  locale: string,
  onEnd: () => void
): FigurePlayer {
  const cycle = Number(svg.dataset.cycle);
  const variants = Number(svg.dataset.variants) || 1;
  let want = false;
  let busy = false;
  let runs = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers = timers.filter((other) => other !== timer);
      fn();
    }, ms);
    timers.push(timer);
  };

  /* a counter moves by data-step at each of data-at, rolling over data-dur ms when it has one;
     with data-max it goes back to where it started, at the reset, once it has gone past it */
  const counters: Counter[] = [...svg.querySelectorAll("[data-at]")].map((el) => {
    const d = dataOf(el);
    const n = Number(d.n);
    return {
      el,
      n,
      n0: n,
      step: Number(d.step || 1),
      dec: Number(d.dec || 0),
      dur: Number(d.dur || 0),
      max: d.max != null ? Number(d.max) : null,
      at: (d.at ?? "").split(",").map(Number),
      unit: d.unit || "",
    };
  });
  const show = (c: Counter, v: number) => {
    c.el.textContent = formatNumber(locale, v, c.dec) + c.unit;
  };
  /* the frames of the counters rolling now, cancelled when the figure stops */
  const rolls = new Set<number>();
  const roll = (fn: FrameRequestCallback) => {
    const id = requestAnimationFrame((now) => {
      rolls.delete(id);
      fn(now);
    });
    rolls.add(id);
  };
  const bump = (c: Counter) => {
    const a = c.n;
    c.n = Math.round((c.n + c.step) * 1e6) / 1e6;
    const b = c.n;
    if (!c.dur) {
      show(c, b);
      return;
    }
    const t0 = performance.now();
    const frame = (now: number) => {
      const u = Math.min(1, (now - t0) / c.dur);
      show(c, a + (b - a) * easeOutCubic(u));
      if (u < 1 && busy) roll(frame);
      else show(c, b);
    };
    roll(frame);
  };

  const sequences: Sequence[] = [...svg.querySelectorAll("[data-seq]")].map((el) => {
    const d = dataOf(el);
    return {
      el,
      list: (d.seq ?? "").split("|"),
      i: Number(d.i) || 0,
      inc: Number(d.inc || 1),
      at: d.stepAt ? Number(d.stepAt) : null,
    };
  });
  const step = (q: Sequence) => {
    q.i += q.inc;
    q.el.textContent = q.list[q.i % q.list.length];
  };

  const run = () => {
    busy = true;
    svg.classList.remove("live");
    svg.classList.toggle("v1", runs++ % variants === 1);
    /* restart the CSS animations from their first frame */
    reflow(svg);
    svg.classList.add("live");
    for (const c of counters) for (const ms of c.at) later(() => bump(c), ms);
    for (const q of sequences) {
      const at = q.at;
      if (at == null) continue;
      later(() => {
        step(q);
        q.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
      }, at);
    }
    later(() => {
      svg.classList.remove("live");
      for (const q of sequences) if (q.at == null) step(q);
      busy = false;
      for (const c of counters) {
        if (c.max == null || c.n <= c.max) continue;
        c.n = c.n0;
        show(c, c.n);
        c.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
      }
      onEnd();
      later(() => {
        if (want && !busy) run();
      }, CYCLE_PAUSE);
    }, cycle);
  };

  const cycles = Math.max(2, variants);
  return {
    dwell: cycles * cycle + (cycles - 1) * CYCLE_PAUSE,
    get busy() {
      return busy;
    },
    start() {
      want = true;
      if (!busy) run();
    },
    ease() {
      want = false;
    },
    stop() {
      want = false;
      busy = false;
      for (const timer of timers) clearTimeout(timer);
      timers = [];
      for (const id of rolls) cancelAnimationFrame(id);
      rolls.clear();
      svg.classList.remove("live");
    },
  };
}
