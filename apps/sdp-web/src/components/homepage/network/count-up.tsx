"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { easeOutCubic } from "@/lib/easing";
import { formatNumber } from "@/lib/number-format";

const DURATION_MS = 1100;

/** The figure shown `k` (0..1) of the way through the count: ease-out cubic, whole numbers. */
export function countAt(to: number, k: number): number {
  return Math.round(to * easeOutCubic(k));
}

type CountUpProps = {
  to: number;
  /** The catalog's figure, with `{count}` where the number goes (e.g. "{count}+"). */
  message: MessageKey;
};

/**
 * A figure that counts up once, from zero, the first time it comes on screen. It counts only when
 * it was off screen as the page started, so a figure already in view never jumps back to zero;
 * until it counts (and under reduced motion, and before hydration) the final figure is there. Assistive
 * tech reads the final figure once from a static copy; the moving digits are hidden from it.
 */
export function CountUp({ to, message }: CountUpProps) {
  const t = useTranslations();
  const locale = useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reducedMotion = useReducedMotion();
  const [armed, setArmed] = useState(false);
  const [value, setValue] = useState(to);

  // off screen at the start: count when it arrives. The final figure stays until then, so a page
  // scrolled past quickly, printed or crawled never shows a zero.
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion) return;
    const box = el.getBoundingClientRect();
    if (box.bottom > 0 && box.top < window.innerHeight) return;
    setArmed(true);
  }, [reducedMotion]);

  useEffect(() => {
    if (!armed || !inView) return;
    if (reducedMotion) {
      setValue(to);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const k = (now - start) / DURATION_MS;
      setValue(countAt(to, k));
      if (k < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [armed, inView, reducedMotion, to]);

  return (
    <>
      <span ref={ref} aria-hidden="true">
        {t(message, { count: formatNumber(locale, value) })}
      </span>
      <span className="sr-only">{t(message, { count: formatNumber(locale, to) })}</span>
    </>
  );
}
