"use client";

import { CheckIcon, Clock3Icon, LoaderCircleIcon, ShieldCheckIcon } from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const stepTransition = { duration: 0.18, ease: "easeOut" } as const;

function EarnFlowStepConnector({
  filled,
  reduceMotion,
}: {
  filled: boolean;
  reduceMotion: boolean;
}) {
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
  if (complete) return "border-primary bg-primary text-on-primary";
  if (active) {
    return "border-primary bg-surface-raised text-primary shadow-[0_0_0_3px_var(--color-fill-subtle)]";
  }
  return "border-border-default bg-surface-raised text-tertiary";
}

function processingMarkerAnimation(
  active: boolean,
  processingActive: boolean,
  reduceMotion: boolean
) {
  if (processingActive && !reduceMotion) return { scale: [1.06, 1.14, 1.06] };
  return { scale: active ? 1.06 : 1 };
}

function processingMarkerTransition(active: boolean, reduceMotion: boolean) {
  if (reduceMotion) return { duration: 0 };
  if (active) {
    return { duration: 1.6, ease: "easeInOut" as const, repeat: Number.POSITIVE_INFINITY };
  }
  return stepTransition;
}

function EarnFlowStepMarker({
  active,
  complete,
  index,
  processing,
  reduceMotion,
}: {
  active: boolean;
  complete: boolean;
  index: number;
  processing: boolean;
  reduceMotion: boolean;
}) {
  const processingActive = active && processing;
  return (
    <m.span
      aria-hidden="true"
      animate={processingMarkerAnimation(active, processingActive, reduceMotion)}
      className={cn(
        "relative z-10 flex size-6 items-center justify-center rounded-full border text-[10px] font-medium",
        stepMarkerClassName(active, complete)
      )}
      data-earn-step-processing={processingActive ? "true" : undefined}
      initial={false}
      transition={processingMarkerTransition(processingActive, reduceMotion)}
    >
      {complete ? <CheckIcon className="size-3" strokeWidth={2.5} /> : index + 1}
    </m.span>
  );
}

function EarnFlowStep({
  active,
  complete,
  index,
  processing,
  reduceMotion,
  step,
}: {
  active: boolean;
  complete: boolean;
  index: number;
  processing: boolean;
  reduceMotion: boolean;
  step: string;
}) {
  return (
    <li className="relative flex min-w-0 flex-1 flex-col items-center">
      {index > 0 ? (
        <EarnFlowStepConnector filled={complete || active} reduceMotion={reduceMotion} />
      ) : null}
      <EarnFlowStepMarker
        active={active}
        complete={complete}
        index={index}
        processing={processing}
        reduceMotion={reduceMotion}
      />
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
          key={stepKey}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? { duration: 0 } : stepTransition}
        >
          {children}
        </m.div>
      </m.div>
    </LazyMotion>
  );
}

export function EarnFlowStepper({
  currentStep,
  processing = false,
  steps,
}: {
  currentStep: number;
  processing?: boolean;
  steps: readonly string[];
}) {
  const reduceMotion = useReducedMotion();
  const t = useTranslations();

  return (
    <LazyMotion features={domAnimation}>
      <nav aria-label={t("DashboardEarn.deposit.progressLabel")} className="mb-6">
        <ol className="flex items-start">
          {steps.map((step, index) => {
            const complete = index < currentStep;
            const active = index === currentStep;
            return (
              <EarnFlowStep
                active={active}
                complete={complete}
                index={index}
                key={step}
                processing={processing}
                reduceMotion={Boolean(reduceMotion)}
                step={step}
              />
            );
          })}
        </ol>
      </nav>
    </LazyMotion>
  );
}

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
  const reduceMotion = useReducedMotion();
  const Icon = processing ? LoaderCircleIcon : outcomeIconByTone[tone];

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        aria-hidden="true"
        className={cn(
          "relative mb-4 flex size-12 items-center justify-center rounded-full",
          outcomeToneClassNames[tone]
        )}
        data-earn-processing={processing ? "true" : undefined}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.82 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: "easeOut" }}
      >
        {processing && !reduceMotion ? (
          <m.span
            className="absolute inset-0 rounded-full border border-current"
            initial={false}
            animate={{ opacity: [0.28, 0], scale: [1, 1.42] }}
            transition={{ duration: 1.6, ease: "easeOut", repeat: Number.POSITIVE_INFINITY }}
          />
        ) : null}
        <m.span
          key={processing ? "processing" : tone}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.65 }}
          animate={outcomeIconAnimation(processing, Boolean(reduceMotion))}
          transition={outcomeIconTransition(processing, Boolean(reduceMotion))}
        >
          <Icon className="size-6" strokeWidth={2} />
        </m.span>
      </m.div>
    </LazyMotion>
  );
}
