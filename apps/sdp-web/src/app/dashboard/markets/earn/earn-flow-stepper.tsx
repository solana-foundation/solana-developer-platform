"use client";

import { CheckIcon } from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const stepTransition = { duration: 0.18, ease: "easeOut" } as const;
const checkTransition = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;

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

function stepMarkerClassName(active: boolean, complete: boolean, terminal: boolean): string {
  if (complete) return "border-primary bg-white text-black";
  if (active) {
    return cn(
      "border-primary shadow-[0_0_0_3px_var(--color-fill-subtle)]",
      terminal ? "bg-white text-black" : "bg-surface-raised text-primary"
    );
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
  terminal: boolean;
}): ReactNode {
  const { active, complete, index, reduceMotion, terminal } = input;
  const terminalActive = active && terminal;
  return (
    <m.span
      aria-hidden="true"
      animate={stepMarkerAnimation(active)}
      className={cn(
        "relative z-10 flex size-6 items-center justify-center rounded-full border text-[10px] font-medium transition-[background-color,border-color,color,box-shadow] duration-200 ease-out",
        stepMarkerClassName(active, complete, terminal)
      )}
      data-earn-step-complete={complete ? "true" : undefined}
      data-earn-step-terminal-active={terminalActive ? "true" : undefined}
      initial={false}
      transition={reduceMotion ? { duration: 0 } : stepTransition}
    >
      {complete ? (
        <m.span
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          className="flex items-center justify-center"
          data-earn-step-check="true"
          initial={reduceMotion ? false : { opacity: 0, rotate: -8, scale: 0.7 }}
          transition={reduceMotion ? { duration: 0 } : checkTransition}
        >
          <CheckIcon className="size-3" strokeWidth={2.5} />
        </m.span>
      ) : (
        index + 1
      )}
    </m.span>
  );
}

function renderStep(input: {
  active: boolean;
  complete: boolean;
  index: number;
  reduceMotion: boolean;
  step: string;
  terminal: boolean;
}): ReactNode {
  const { active, complete, index, reduceMotion, step, terminal } = input;
  return (
    <li className="relative flex min-w-0 flex-1 flex-col items-center" key={step}>
      {index > 0 ? renderStepConnector(complete || active, reduceMotion) : null}
      {renderStepMarker({ active, complete, index, reduceMotion, terminal })}
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
              terminal: index === steps.length - 1,
            })
          )}
        </ol>
      </nav>
    </LazyMotion>
  );
}
