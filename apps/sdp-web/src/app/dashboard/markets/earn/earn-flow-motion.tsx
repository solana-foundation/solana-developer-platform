"use client";

import { CheckIcon, Clock3Icon, LoaderCircleIcon, ShieldCheckIcon } from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const stepTransition = { duration: 0.18, ease: "easeOut" } as const;

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
  const processingActive = active && processing;

  return (
    <li className="relative flex min-w-0 flex-1 flex-col items-center">
      {index > 0 ? (
        <span
          aria-hidden="true"
          className="absolute top-3 right-1/2 h-px w-full overflow-hidden bg-border-default"
        >
          <m.span
            className="block h-full origin-left bg-primary"
            initial={false}
            animate={{ scaleX: complete || active ? 1 : 0 }}
            transition={reduceMotion ? { duration: 0 } : stepTransition}
          />
        </span>
      ) : null}
      <m.span
        aria-hidden="true"
        className={cn(
          "relative z-10 flex size-6 items-center justify-center rounded-full border text-[10px] font-medium",
          complete
            ? "border-primary bg-primary text-on-primary"
            : active
              ? "border-primary bg-surface-raised text-primary shadow-[0_0_0_3px_var(--color-fill-subtle)]"
              : "border-border-default bg-surface-raised text-tertiary"
        )}
        data-earn-step-processing={processingActive ? "true" : undefined}
        initial={false}
        animate={
          processingActive && !reduceMotion
            ? { scale: [1.06, 1.14, 1.06] }
            : { scale: active ? 1.06 : 1 }
        }
        transition={
          reduceMotion
            ? { duration: 0 }
            : processingActive
              ? { duration: 1.6, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY }
              : stepTransition
        }
      >
        {complete ? <CheckIcon className="size-3" strokeWidth={2.5} /> : index + 1}
      </m.span>
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
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousHeightRef = useRef<number | null>(null);
  const previousStepKeyRef = useRef(stepKey);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const nextHeight = content.getBoundingClientRect().height;
    const previousHeight = previousHeightRef.current;
    const stepChanged = previousStepKeyRef.current !== stepKey;
    previousHeightRef.current = nextHeight;
    previousStepKeyRef.current = stepKey;
    if (
      reduceMotion ||
      !stepChanged ||
      previousHeight === null ||
      Math.abs(previousHeight - nextHeight) < 1 ||
      typeof container.animate !== "function"
    ) {
      return;
    }

    container.style.overflow = "hidden";
    const animation = container.animate(
      [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
      { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );
    const clearOverflow = () => {
      container.style.overflow = "";
    };
    animation.addEventListener("finish", clearOverflow, { once: true });
    animation.addEventListener("cancel", clearOverflow, { once: true });
    return () => animation.cancel();
  }, [reduceMotion, stepKey]);

  return (
    <LazyMotion features={domAnimation}>
      <div ref={containerRef}>
        <m.div
          key={stepKey}
          ref={contentRef}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? { duration: 0 } : stepTransition}
        >
          {children}
        </m.div>
      </div>
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

export function EarnOutcomeMark({
  processing = false,
  tone,
}: {
  processing?: boolean;
  tone: EarnOutcomeTone;
}) {
  const reduceMotion = useReducedMotion();
  const Icon = processing
    ? LoaderCircleIcon
    : tone === "success"
      ? CheckIcon
      : tone === "warning"
        ? Clock3Icon
        : ShieldCheckIcon;

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
          animate={
            processing && !reduceMotion
              ? { opacity: 1, rotate: 360, scale: 1 }
              : { opacity: 1, rotate: 0, scale: 1 }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : processing
                ? { duration: 1.15, ease: "linear", repeat: Number.POSITIVE_INFINITY }
                : { delay: 0.08, duration: 0.18 }
          }
        >
          <Icon className="size-6" strokeWidth={2} />
        </m.span>
      </m.div>
    </LazyMotion>
  );
}
