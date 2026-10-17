import { watchActive } from "@/lib/use-scene-active";
import { NARROW_QUERY } from "./layout";
import { restartAttribute } from "./restart-animation";

/*
 * The motion the page's bubbles (a pill in two rings) share: the timeline runner of the bubbles
 * that repeat a gesture on their own (pillars, privacy).
 */

/** On wide screens every bubble is staggered on the page by this much, in page order. */
const STAGGER = 1100;
/** A bubble's timeline starts this long after its block has landed. */
export const BUBBLE_LAND_DELAY = 900;

/**
 * Where a bubble's clock starts: on wide screens it waits for its `slot` in page order (the
 * stack's three come first, then the pillars', payments' and privacy's); on a phone it starts at once.
 */
export function bubbleClockStart(slot: number) {
  return window.matchMedia(NARROW_QUERY).matches ? 0 : -slot * STAGGER;
}

export type BubbleTools = {
  /** Runs `fn` after `ms`, cancelled with the loop. */
  later: (fn: () => void, ms: number) => void;
  /** Restarts the bubble's beat keyframes (data-beat). */
  beat: () => void;
};

/**
 * Runs a bubble's timeline: `makeTick` returns the step that advances it by `dt` ms of real time.
 * It starts BUBBLE_LAND_DELAY after the call, runs only while the bubble is near the screen and the
 * tab is visible (data-paused stops the rings' breathing otherwise). Returns the stop function.
 */
export function runBubbleLoop(
  root: HTMLElement,
  makeTick: (tools: BubbleTools) => (dt: number) => void
) {
  const timers = new Set<number>();
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };
  const beat = () => restartAttribute(root, "data-beat");

  const tick = makeTick({ later, beat });
  let landed = false;
  /* near the screen and the tab visible */
  let shown = false;
  let raf = 0;
  let last = 0;

  const running = () => landed && shown;

  // real time, even where frames are throttled
  const frame = (now: number) => {
    raf = 0;
    if (!running()) return;
    const dt = Math.min(1000, now - last);
    last = now;
    raf = window.requestAnimationFrame(frame);
    tick(dt);
  };

  // starts or stops the loop and the rings' breathing with what is on screen
  const sync = () => {
    root.toggleAttribute("data-paused", !shown);
    if (running() && !raf) {
      last = performance.now();
      raf = window.requestAnimationFrame(frame);
    }
  };

  later(() => {
    landed = true;
    sync();
  }, BUBBLE_LAND_DELAY);

  const stopWatching = watchActive(root, { rootMargin: "120px" }, (active) => {
    shown = active;
    sync();
  });

  return () => {
    if (raf) window.cancelAnimationFrame(raf);
    for (const id of timers) window.clearTimeout(id);
    stopWatching();
  };
}

/** The pill fits its word: the word as it stands plus the room either side of it (--pxx). */
export function fitPill(pill: HTMLElement, word: HTMLElement | null | undefined) {
  if (word) pill.style.width = `calc(${word.offsetWidth.toFixed(1)}px + var(--pxx))`;
}
