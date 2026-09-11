"use client";

import { CheckIcon, Clock3Icon, ShieldCheckIcon } from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

type EarnOutcomeTone = "info" | "success" | "warning";

const outcomeToneClassNames: Record<EarnOutcomeTone, string> = {
  info: "bg-info-bg text-info",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
};

const outcomeIconByTone: Record<EarnOutcomeTone, ComponentType<SVGProps<SVGSVGElement>>> = {
  info: ShieldCheckIcon,
  success: CheckIcon,
  warning: Clock3Icon,
};

export function EarnOutcomeMark({ tone }: { tone: EarnOutcomeTone }) {
  const reduceMotion = Boolean(useReducedMotion());
  const Icon = outcomeIconByTone[tone];

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        animate={{ opacity: 1, scale: 1 }}
        aria-hidden="true"
        className={cn(
          "relative mx-auto mb-4 flex size-12 items-center justify-center rounded-full",
          outcomeToneClassNames[tone]
        )}
        data-earn-outcome={tone}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.82 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: "easeOut" }}
      >
        <m.span
          animate={{ opacity: 1, scale: 1 }}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.65 }}
          key={tone}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.08, duration: 0.18 }}
        >
          <Icon className="size-6" strokeWidth={2} />
        </m.span>
      </m.div>
    </LazyMotion>
  );
}
