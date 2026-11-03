"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRiseArrived, useRiseDelay } from "@/components/homepage/rise";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { easeOutCubic } from "@/lib/easing";
import { formatNumber } from "@/lib/number-format";

const DURATION_MS = 1000;
/** The count starts this long after its block starts to fade in. */
const LAG_MS = 80;

const subscribeToHydration = () => () => {};

/** The figure shown `k` (0..1) of the way through the count: ease-out cubic, whole numbers. */
export function countAt(to: number, k: number): number {
  return Math.round(to * easeOutCubic(k));
}

/** The final figure (before hydration, under reduced motion), the running count, or zero until its block arrives. */
type Display = "final" | "counting" | "waiting";

function displayOf(hydrated: boolean, reducedMotion: boolean | null, arrived: boolean): Display {
  if (!hydrated || reducedMotion) return "final";
  return arrived ? "counting" : "waiting";
}

function displayedValue(display: Display, to: number, progress: number): number {
  switch (display) {
    case "final":
      return to;
    case "counting":
      return countAt(to, progress);
    case "waiting":
      return 0;
    default: {
      const exhaustive: never = display;
      throw new Error(`Unhandled count-up display: ${exhaustive}`);
    }
  }
}

type CountUpProps = {
  to: number;
  /** The catalog's figure, with `{count}` where the number goes (e.g. "{count}+"). */
  message: MessageKey;
};

/**
 * A figure that counts up once, from zero, as its `Rise` block comes in (outside any block, the
 * first time it comes on screen). Once the page runs it stands at zero, hidden with its block,
 * until then, so it never shows the final figure first and restarts from zero; before hydration
 * and under reduced motion the final figure is there. Assistive tech reads the final figure once
 * from a static copy; the moving digits are hidden from it.
 */
export function CountUp({ to, message }: CountUpProps) {
  const t = useTranslations();
  const locale = useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const riseArrived = useRiseArrived();
  const riseDelay = useRiseDelay();
  const reducedMotion = useReducedMotion();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );
  /** How far through the count the animation has run (0..1+); only the animation writes it. */
  const [progress, setProgress] = useState(0);
  const arrived = riseArrived ?? inView;
  const value = displayedValue(displayOf(hydrated, reducedMotion, arrived), to, progress);

  useEffect(() => {
    if (reducedMotion || !arrived) return;
    let frame = 0;
    // with its block's own fade
    const timer = window.setTimeout(() => {
      const start = performance.now();
      frame = requestAnimationFrame(function tick(now) {
        const k = (now - start) / DURATION_MS;
        setProgress(k);
        if (k < 1) frame = requestAnimationFrame(tick);
      });
    }, riseDelay + LAG_MS);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [arrived, reducedMotion, riseDelay]);

  return (
    <>
      <span ref={ref} aria-hidden="true">
        {t(message, { count: formatNumber(locale, value) })}
      </span>
      <span className="sr-only">{t(message, { count: formatNumber(locale, to) })}</span>
    </>
  );
}
