"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/provider";

const DURATION_MS = 1100;

type CountUpProps = { to: number; suffix?: string };

/**
 * A number that counts up to its value the first time it is seen. The final
 * value is what the server renders and what assistive technology reads; only
 * the drawn copy moves, and under reduced motion it does not.
 */
export function CountUp({ to, suffix = "" }: CountUpProps) {
  const locale = useLocale();
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const [shown, setShown] = useState(to);
  const format = (value: number) => `${new Intl.NumberFormat(locale).format(value)}${suffix}`;

  useEffect(() => {
    if (!inView || reducedMotion !== false) return;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const k = Math.min(1, (now - start) / DURATION_MS);
      setShown(Math.round(to * (1 - (1 - k) ** 3)));
      if (k < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [inView, reducedMotion, to]);

  return (
    <span ref={ref}>
      <span className="sr-only">{format(to)}</span>
      <span aria-hidden="true">{format(shown)}</span>
    </span>
  );
}
