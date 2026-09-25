"use client";

import { useReducedMotion } from "motion/react";
import { type RefObject, useEffect } from "react";

/**
 * Runs the headline form-in on `ref` once `active` turns true: the heading's
 * `data-form` goes hidden → outline → mat → solid, and each letter's own
 * transition delay staggers it. The heading is server-rendered as
 * `data-form="hidden"`; under reduced motion it goes straight to solid.
 *
 * It drives markup it does not draw: the `[data-letter]` spans from
 * components/homepage/form-letters.tsx, styled per state by
 * components/homepage/form-heading.module.css.
 */
export function useFormIn(ref: RefObject<HTMLElement | null>, active: boolean, stepMs: number) {
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const heading = ref.current;
    if (!heading || !active) return;
    if (reducedMotion) {
      heading.dataset.form = "solid";
      return;
    }

    const letters = heading.querySelectorAll("[data-letter]").length;
    const spread = letters * stepMs * 0.5;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Two frames, so the hidden state is painted before the letters rise out of it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        heading.dataset.form = "outline";
        timers.push(setTimeout(() => (heading.dataset.form = "mat"), 380 + spread * 0.4));
        timers.push(setTimeout(() => (heading.dataset.form = "solid"), 980 + spread * 0.6));
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [ref, active, stepMs, reducedMotion]);
}
