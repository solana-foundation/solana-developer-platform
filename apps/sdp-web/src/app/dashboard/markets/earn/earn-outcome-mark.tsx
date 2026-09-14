"use client";

import { CheckIcon, Clock3Icon, LoaderCircleIcon, ShieldCheckIcon } from "lucide-react";
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

function outcomeIconAnimation(processing: boolean, reduceMotion: boolean) {
  if (processing && !reduceMotion) return { opacity: 1, rotate: 360, scale: 1 };
  return { opacity: 1, rotate: 0, scale: 1 };
}

function outcomeIconTransition(processing: boolean, reduceMotion: boolean) {
  if (reduceMotion) return { duration: 0 };
  if (processing) {
    return { duration: 1.15, ease: "linear" as const, repeat: Number.POSITIVE_INFINITY };
  }
  return { delay: 0.08, duration: 0.18 };
}

export function EarnOutcomeMark({
  processing = false,
  tone,
}: {
  processing?: boolean;
  tone: EarnOutcomeTone;
}) {
  const reduceMotion = Boolean(useReducedMotion());
  const Icon = processing ? LoaderCircleIcon : outcomeIconByTone[tone];

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        animate={{ opacity: 1, scale: 1 }}
        aria-hidden="true"
        className={cn(
          "relative mb-4 flex size-12 items-center justify-center rounded-full",
          outcomeToneClassNames[tone]
        )}
        data-earn-processing={processing ? "true" : undefined}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.82 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: "easeOut" }}
      >
        {processing && !reduceMotion ? (
          <m.span
            animate={{ opacity: [0.28, 0], scale: [1, 1.42] }}
            className="absolute inset-0 rounded-full border border-current"
            initial={false}
            transition={{ duration: 1.6, ease: "easeOut", repeat: Number.POSITIVE_INFINITY }}
          />
        ) : null}
        <m.span
          animate={outcomeIconAnimation(processing, reduceMotion)}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.65 }}
          key={processing ? "processing" : tone}
          transition={outcomeIconTransition(processing, reduceMotion)}
        >
          <Icon className="size-6" strokeWidth={2} />
        </m.span>
      </m.div>
    </LazyMotion>
  );
}
