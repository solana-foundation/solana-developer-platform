"use client";

import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

const stepTransition = { duration: 0.18, ease: "easeOut" } as const;

export function EarnFlowTransition({
  children,
  stepKey,
}: {
  children: ReactNode;
  stepKey: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        layout="size"
        transition={
          reduceMotion ? { duration: 0 } : { layout: { duration: 0.24, ease: [0.16, 1, 0.3, 1] } }
        }
      >
        <m.div
          animate={{ opacity: 1, y: 0 }}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          key={stepKey}
          transition={reduceMotion ? { duration: 0 } : stepTransition}
        >
          {children}
        </m.div>
      </m.div>
    </LazyMotion>
  );
}
