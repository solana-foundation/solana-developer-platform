import { watchActive } from "@/lib/use-scene-active";
import { NARROW_QUERY } from "./layout";
import { restartAttribute } from "./restart-animation";

/*
 * The motion the page's bubbles (a pill in two rings) share: the pointer's wave through the rings,
 * and the timeline runner of the bubbles that repeat a gesture on their own (pillars, privacy).
 */

/** On wide screens every bubble is staggered on the page by this much, in page order. */
const STAGGER = 1100;
/** A bubble's timeline starts this long after its block has landed. */
export const BUBBLE_LAND_DELAY = 900;

const WAVE_PROPS = ["--s0", "--s1", "--s2", "--rp", "--rs"] as const;

/**
 * Where a bubble's clock starts: on wide screens it waits for its `slot` in page order (the
 * stack's three come first, then the pillars', payments' and privacy's); on a phone it starts at once.
 */
export function bubbleClockStart(slot: number) {
  return window.matchMedia(NARROW_QUERY).matches ? 0 : -slot * STAGGER;
}

/**
 * The pointer's wave: moving the mouse up and down feeds energy that runs out through the pill,
 * the inner ring, the outer ring and the ripple (--s0..--rs), and settles when the hand rests.
 */
function createBubbleWave(root: HTMLElement) {
  let energy = 0;
  let phase = 0;
  let lastY: number | null = null;

  return {
    start(y: number) {
      lastY = y;
    },
    move(y: number) {
      const dy = y - (lastY ?? y);
      lastY = y;
      energy = Math.min(1, energy + Math.abs(dy) / 60);
      phase += dy * 0.04;
    },
    step(dt: number) {
      energy *= 0.94 ** (dt / 16);
      if (energy < 0.002) energy = 0;
      const wave = (offset: number) => Math.sin(phase - offset);
      root.style.setProperty("--s0", (1 + 0.075 * energy * wave(0)).toFixed(4));
      root.style.setProperty("--s1", (1 + 0.05 * energy * wave(0.7)).toFixed(4));
      root.style.setProperty("--s2", (1 + 0.034 * energy * wave(1.4)).toFixed(4));
      root.style.setProperty("--rp", (0.9 * energy * Math.max(0, wave(2))).toFixed(3));
      root.style.setProperty("--rs", (1 + 0.1 * energy * Math.max(0, wave(2))).toFixed(4));
    },
    clear() {
      energy = 0;
      for (const name of WAVE_PROPS) root.style.removeProperty(name);
    },
  };
}

/**
 * Under a mouse the bubble's own motion holds (data-hand) and moving the pointer up and down drives
 * the wave instead, until the pointer leaves. `canStart` says whether the bubble takes the hand
 * yet; `onChange` hears when the hand comes and goes. Returns the stop function.
 */
export function followHand(
  root: HTMLElement,
  { canStart, onChange }: { canStart?: () => boolean; onChange?: (hand: boolean) => void } = {}
) {
  const wave = createBubbleWave(root);
  let hand = false;
  let raf = 0;
  let last = 0;

  const frame = (now: number) => {
    const dt = Math.min(1000, now - last);
    last = now;
    wave.step(dt);
    raf = window.requestAnimationFrame(frame);
  };

  const onEnter = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || (canStart && !canStart())) return;
    hand = true;
    wave.start(event.clientY);
    root.removeAttribute("data-beat");
    root.setAttribute("data-hand", "");
    onChange?.(true);
    if (!raf) {
      last = performance.now();
      raf = window.requestAnimationFrame(frame);
    }
  };
  const onMove = (event: PointerEvent) => {
    if (hand) wave.move(event.clientY);
  };
  const release = () => {
    window.cancelAnimationFrame(raf);
    raf = 0;
    hand = false;
    wave.clear();
    root.removeAttribute("data-hand");
  };
  const onLeave = () => {
    if (!hand) return;
    release();
    onChange?.(false);
  };

  root.addEventListener("pointerenter", onEnter);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerleave", onLeave);

  return () => {
    if (hand) release();
    root.removeEventListener("pointerenter", onEnter);
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerleave", onLeave);
  };
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
 * tab is visible (data-paused stops the rings' breathing otherwise), and under a mouse it holds
 * while the pointer's wave runs instead (followHand). Returns the stop function.
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
  let hand = false;
  let raf = 0;
  let last = 0;

  const running = () => landed && shown;

  // real time, even where frames are throttled; the timeline holds while the hand is on it
  const frame = (now: number) => {
    raf = 0;
    if (!running()) return;
    const dt = Math.min(1000, now - last);
    last = now;
    raf = window.requestAnimationFrame(frame);
    if (!hand) tick(dt);
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

  const stopHand = followHand(root, {
    onChange: (on) => {
      hand = on;
    },
  });

  return () => {
    if (raf) window.cancelAnimationFrame(raf);
    for (const id of timers) window.clearTimeout(id);
    stopWatching();
    stopHand();
  };
}

/** The pill fits its word: the word as it stands plus the room either side of it (--pxx). */
export function fitPill(pill: HTMLElement, word: HTMLElement | null | undefined) {
  if (word) pill.style.width = `calc(${word.offsetWidth.toFixed(1)}px + var(--pxx))`;
}
