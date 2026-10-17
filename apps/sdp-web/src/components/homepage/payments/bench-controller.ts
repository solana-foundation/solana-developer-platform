/*
 * The bench of payment kinds. The index names the kinds; the stage draws the chosen one and
 * plays its motion. While the bench is on screen it walks through the kinds by itself:
 * each figure plays its own cycles and hands over at rest, the active row's rule filling as it
 * goes; one drawing fades out, then the next fades in. A click takes the stage and the walk goes
 * on from there; the arrow keys keep it there until play is pressed again; the
 * mouse on the drawing holds the walk while it is there. Off screen, in a hidden tab or under
 * reduced motion nothing runs.
 */

import { watchActive } from "@/lib/use-scene-active";
import { reflow } from "../restart-animation";
import { createFigurePlayer, type FigurePlayer } from "./figures/player";
import { figureViewBox, type PaymentKind } from "./kinds";

const FADE_OUT = 500;
const FADE_IN = 800;
const SNUG_QUERY = "(max-width:600px), (max-height:500px) and (orientation:landscape)";

export type BenchClasses = { fig: string; on: string; out: string };

export type BenchOptions = {
  kinds: readonly PaymentKind[];
  stage: HTMLElement;
  deck: HTMLElement;
  list: HTMLElement;
  tabs: () => (HTMLElement | null)[];
  bars: () => (HTMLElement | null)[];
  classes: BenchClasses;
  reducedMotion: boolean;
  /** The reader's locale, for the figures' numbers. */
  locale: string;
  /** The kind on the stage changed: the tabs and the bubble follow it. */
  onShow: (index: number) => void;
  /** Whether the walk is set to run (the play/pause control's state). */
  onPlayingChange: (playing: boolean) => void;
};

export type BenchController = {
  /** Puts the drawn figures on the stage (markup per kind, in the kinds' order). */
  load(figures: (string | null)[]): void;
  /** The bench has arrived on screen: the first kind takes the stage. */
  arrive(): void;
  select(index: number): void;
  keyDown(event: KeyboardEvent): void;
  togglePlay(): void;
  destroy(): void;
};

export function createBenchController(o: BenchOptions): BenchController {
  const { kinds, stage, deck, list, classes } = o;
  const calm = o.reducedMotion;
  const snug = window.matchMedia(SNUG_QUERY);
  let layers: HTMLElement[] = [];
  let players: (FigurePlayer | null)[] = [];
  let cur = -1;
  let auto = !calm;
  let hand = false;
  let seen = false;
  let pinned = false;
  let due = false;
  let arrived = false;
  let bar: Animation | null = null;
  let settle: (() => void) | null = null;
  let touching = 0;
  let destroyed = false;
  const fades: Animation[] = [];

  const running = () => auto && !hand && seen && !pinned && !document.hidden;

  /* a drawing taken off the stage goes at once, not through the fade */
  const hide = (el: HTMLElement) => {
    el.style.transition = "none";
    el.classList.remove(classes.out);
    reflow(el);
    el.style.transition = "";
  };

  /* the strip of kinds, where it scrolls sideways, brings the chosen one in; not while a finger
     is on it */
  const bring = (i: number) => {
    const tabs = o.tabs();
    const tab = tabs[i];
    const first = tabs[0];
    if (!tab || !first) return;
    if (list.scrollWidth <= list.clientWidth + 1 || performance.now() < touching) return;
    list.scrollTo({ left: tab.offsetLeft - first.offsetLeft, behavior: calm ? "auto" : "smooth" });
  };

  function ended(el: HTMLElement) {
    if (layers[cur] !== el) return;
    if (due && running()) {
      due = false;
      show((cur + 1) % kinds.length);
    }
  }

  function fill() {
    bar?.cancel();
    bar = null;
    due = false;
    const p = players[cur];
    const line = o.bars()[cur];
    if (!p || !line || calm) return;
    const next = line.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
      duration: p.dwell,
      easing: "linear",
      fill: "forwards",
    });
    /* the rule is full: a figure already at rest hands on now, one still moving hands on as its
       cycle comes back to rest */
    next.onfinish = () => {
      if (running() && !players[cur]?.busy) show((cur + 1) % kinds.length);
      else due = true;
    };
    if (!running()) next.pause();
    bar = next;
  }

  function sync() {
    if (destroyed) return;
    if (bar) {
      if (running()) bar.play();
      else bar.pause();
    }
    o.onPlayingChange(auto && !pinned);
    const p = players[cur];
    if (!p) return;
    if (seen && !document.hidden && !calm) p.start();
    else p.ease();
  }

  function swapLayers(prev: number) {
    const inc = layers[cur];
    const out = layers[prev];
    const p0 = players[prev];
    if (!inc) return;
    settle?.();
    p0?.ease();
    const fading = out && !calm;
    /* the classes change at once; the fades run here, so the old drawing is gone before the new
       one comes up: the drawings have no ground of their own */
    inc.style.transition = "none";
    if (out) out.style.transition = "none";
    layers.forEach((el, n) => {
      el.classList.toggle(classes.on, n === cur);
      el.classList.toggle(classes.out, n === prev && Boolean(fading));
    });
    reflow(inc);
    inc.style.transition = "";
    if (out) out.style.transition = "";
    if (out && fading) {
      const a = out.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_OUT,
        easing: "cubic-bezier(.4,0,1,1)",
        fill: "forwards",
      });
      const b = inc.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: FADE_IN,
        delay: FADE_OUT,
        easing: "cubic-bezier(.32,.72,0,1)",
        fill: "backwards",
      });
      fades.splice(0, fades.length, a, b);
      const gone = () => {
        hide(out);
        a.cancel();
        if (cur !== prev) p0?.stop();
      };
      settle = () => {
        settle = null;
        gone();
        b.cancel();
      };
      a.onfinish = () => {
        if (!settle) return;
        gone();
        settle = () => {
          settle = null;
          b.cancel();
        };
      };
      b.onfinish = () => {
        settle = null;
      };
    } else if (out) {
      hide(out);
      p0?.stop();
    }
  }

  function show(i: number, focus = false) {
    if (i === cur) return;
    const prev = cur;
    cur = i;
    o.onShow(i);
    if (focus) o.tabs()[i]?.focus();
    bring(i);
    swapLayers(prev);
    fill();
    sync();
  }

  const frame = () => {
    layers.forEach((el, n) => {
      el.querySelector("svg")?.setAttribute("viewBox", figureViewBox(kinds[n], snug.matches));
    });
  };

  const onPointerDown = () => {
    touching = performance.now() + 4000;
  };
  const onScroll = () => {
    if (touching) touching = performance.now() + 1500;
  };
  const onEnter = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    hand = true;
    sync();
  };
  const onLeave = () => {
    hand = false;
    sync();
  };
  /* a light on the floor that follows the pointer */
  const onMove = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    stage.style.setProperty("--mx", `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
    stage.style.setProperty("--my", `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
  };

  list.addEventListener("pointerdown", onPointerDown, { passive: true });
  list.addEventListener("scroll", onScroll, { passive: true });
  stage.addEventListener("pointerenter", onEnter);
  stage.addEventListener("pointerleave", onLeave);
  stage.addEventListener("pointermove", onMove);
  snug.addEventListener("change", frame);
  const stopWatching = watchActive(stage, { threshold: 0.35 }, (active) => {
    seen = active;
    sync();
  });

  return {
    load(figures) {
      if (destroyed) return;
      layers = kinds.map((kind, n) => {
        const el = document.createElement("div");
        el.className = classes.fig;
        el.dataset.kind = kind;
        /* the drawings are this module's own generated markup, never user input */
        el.innerHTML = figures[n] ?? "";
        deck.appendChild(el);
        return el;
      });
      players = layers.map((el) => {
        const svg = el.querySelector<SVGSVGElement>("svg[data-cycle]");
        return svg ? createFigurePlayer(svg, o.locale, () => ended(el)) : null;
      });
      frame();
      if (arrived) {
        const shown = cur;
        cur = -1;
        show(shown < 0 ? 0 : shown);
      }
    },
    arrive() {
      if (arrived) return;
      arrived = true;
      show(cur < 0 ? 0 : cur);
    },
    select(index) {
      show(index);
      sync();
    },
    keyDown(e) {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      let n = -1;
      if (step) n = (Math.max(cur, 0) + step + kinds.length) % kinds.length;
      else if (e.key === "Home") n = 0;
      else if (e.key === "End") n = kinds.length - 1;
      if (n < 0) return;
      e.preventDefault();
      pinned = true;
      show(n, true);
      sync();
    },
    togglePlay() {
      if (calm) return;
      if (auto && !pinned) auto = false;
      else {
        auto = true;
        pinned = false;
      }
      if (bar && bar.playState === "finished") due = true;
      sync();
    },
    destroy() {
      destroyed = true;
      stopWatching();
      snug.removeEventListener("change", frame);
      list.removeEventListener("pointerdown", onPointerDown);
      list.removeEventListener("scroll", onScroll);
      stage.removeEventListener("pointerenter", onEnter);
      stage.removeEventListener("pointerleave", onLeave);
      stage.removeEventListener("pointermove", onMove);
      bar?.cancel();
      for (const fade of fades) fade.cancel();
      for (const p of players) p?.stop();
      for (const el of layers) el.remove();
      layers = [];
      players = [];
    },
  };
}
