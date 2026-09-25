"use client";

import { useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

/** When each part of the first screen arrives, in ms after mount, as the design times it. */
const STEPS = [
  { at: 350, attribute: "data-w1" },
  { at: 900, attribute: "data-w2" },
  { at: 1500, attribute: "data-tail" },
  { at: 1900, attribute: "data-sel1" },
  { at: 2900, attribute: "data-sel2" },
] as const;

/**
 * The hero's outer element. It marks itself with each step as it is reached,
 * and the hero's styles bring the lines, the lede, the actions, the logo bar
 * and the two phrase bubbles in on those marks. Under reduced motion every
 * mark is set at once.
 */
export function HeroStage({ className, children }: { className: string; children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const [reached, setReached] = useState(0);

  useEffect(() => {
    if (reducedMotion) {
      setReached(STEPS.length);
      return;
    }
    const timers = STEPS.map((step, index) => setTimeout(() => setReached(index + 1), step.at));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [reducedMotion]);

  const marks = Object.fromEntries(STEPS.slice(0, reached).map((step) => [step.attribute, ""]));

  return (
    <section id="top" data-ground="paper" className={className} {...marks}>
      {children}
    </section>
  );
}
