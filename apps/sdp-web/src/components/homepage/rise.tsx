"use client";

import { useInView, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import styles from "./rise.module.css";

type Phase = "shown" | "waiting" | "in";

/**
 * A block that rises into place the first time it scrolls into view. It is
 * rendered visible and only hides itself once the script is running, so the
 * content never depends on the animation; under reduced motion it stays put.
 */
export function Rise({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const inView = useInView(ref, { once: true, margin: "0px 0px -12% 0px", amount: 0.06 });
  const [phase, setPhase] = useState<Phase>("shown");

  useEffect(() => {
    if (reducedMotion) return;
    setPhase((current) => (current === "shown" ? "waiting" : current));
  }, [reducedMotion]);

  useEffect(() => {
    if (inView) setPhase("in");
  }, [inView]);

  return (
    <div ref={ref} className={cn(styles.rise, className)} data-rise={phase}>
      {children}
    </div>
  );
}
