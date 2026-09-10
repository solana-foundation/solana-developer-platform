"use client";

import { CheckIcon, Clock3Icon, ShieldCheckIcon } from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

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
        key={stepKey}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduceMotion ? { duration: 0 } : stepTransition}
      >
        {children}
      </m.div>
    </LazyMotion>
  );
}

export function EarnFlowStepper({
  currentStep,
  steps,
}: {
  currentStep: number;
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
              <li className="relative flex min-w-0 flex-1 flex-col items-center" key={step}>
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
                  initial={false}
                  animate={{ scale: active ? 1.06 : 1 }}
                  transition={reduceMotion ? { duration: 0 } : stepTransition}
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

export function EarnOutcomeMark({ tone }: { tone: EarnOutcomeTone }) {
  const reduceMotion = useReducedMotion();
  const Icon = tone === "success" ? CheckIcon : tone === "warning" ? Clock3Icon : ShieldCheckIcon;

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        aria-hidden="true"
        className={cn(
          "mb-4 flex size-12 items-center justify-center rounded-full",
          outcomeToneClassNames[tone]
        )}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.82 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: "easeOut" }}
      >
        <m.span
          initial={reduceMotion ? false : { opacity: 0, scale: 0.65 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.08, duration: 0.18 }}
        >
          <Icon className="size-6" strokeWidth={2} />
        </m.span>
      </m.div>
    </LazyMotion>
  );
}
