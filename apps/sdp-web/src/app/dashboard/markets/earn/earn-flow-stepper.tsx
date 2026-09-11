"use client";

import { CheckIcon } from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const stepTransition = { duration: 0.18, ease: "easeOut" } as const;

function renderStepConnector(filled: boolean, reduceMotion: boolean): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="absolute top-3 right-1/2 h-px w-full overflow-hidden bg-border-default"
    >
      <m.span
        animate={{ scaleX: filled ? 1 : 0 }}
        className="block h-full origin-left bg-primary"
        initial={false}
        transition={reduceMotion ? { duration: 0 } : stepTransition}
      />
    </span>
  );
}

function stepMarkerClassName(active: boolean, complete: boolean): string {
  if (complete) return "border-primary bg-surface-raised text-primary";
  if (active) {
    return "border-primary bg-surface-raised text-primary shadow-[0_0_0_3px_var(--color-fill-subtle)]";
  }
  return "border-border-default bg-surface-raised text-tertiary";
}

function stepMarkerAnimation(active: boolean) {
  return { scale: active ? 1.06 : 1 };
}

function renderStepMarker(input: {
  active: boolean;
  complete: boolean;
  index: number;
  reduceMotion: boolean;
}): ReactNode {
  const { active, complete, index, reduceMotion } = input;
  return (
    <m.span
      aria-hidden="true"
      animate={stepMarkerAnimation(active)}
      className={cn(
        "relative z-10 flex size-6 items-center justify-center rounded-full border text-[10px] font-medium",
        stepMarkerClassName(active, complete)
      )}
      initial={false}
      transition={reduceMotion ? { duration: 0 } : stepTransition}
    >
      {complete ? <CheckIcon className="size-3" strokeWidth={2.5} /> : index + 1}
    </m.span>
  );
}

function renderStep(input: {
  active: boolean;
  complete: boolean;
  index: number;
  reduceMotion: boolean;
  step: string;
}): ReactNode {
  const { active, complete, index, reduceMotion, step } = input;
  return (
    <li className="relative flex min-w-0 flex-1 flex-col items-center" key={step}>
      {index > 0 ? renderStepConnector(complete || active, reduceMotion) : null}
      {renderStepMarker({ active, complete, index, reduceMotion })}
      <span
        aria-current={active ? "step" : undefined}
        className={cn(
          "mt-2 max-w-full truncate px-1 text-center text-[11px] leading-4",
          active || complete ? "text-primary" : "text-tertiary"
        )}
      >
        {step}
      </span>
    </li>
  );
}

export function EarnFlowStepper({
  currentStep,
  steps,
}: {
  currentStep: number;
  steps: readonly string[];
}) {
  const reduceMotion = Boolean(useReducedMotion());
  const t = useTranslations();

  return (
    <LazyMotion features={domAnimation}>
      <nav aria-label={t("DashboardEarn.deposit.progressLabel")} className="mb-6">
        <ol className="flex items-start">
          {steps.map((step, index) =>
            renderStep({
              active: index === currentStep,
              complete: index < currentStep,
              index,
              reduceMotion,
              step,
            })
          )}
        </ol>
      </nav>
    </LazyMotion>
  );
}
