"use client";

import { Check } from "lucide-react";
import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { stepIndex, WIZARD_STEP_META, type WizardStep } from "./issuance-draft-wizard.types";

interface WizardProgressProps {
  currentStep: WizardStep;
  maxStepReached: WizardStep;
  onStepClick: (step: WizardStep) => void;
}

export function WizardProgress({ currentStep, maxStepReached, onStepClick }: WizardProgressProps) {
  const currentIdx = stepIndex(currentStep);
  const maxIdx = stepIndex(maxStepReached);

  return (
    <ol className="flex items-center">
      {WIZARD_STEP_META.map((step, index) => {
        const isDone = index < currentIdx;
        const isActive = index === currentIdx;
        const isReached = index <= maxIdx;
        const isLast = index === WIZARD_STEP_META.length - 1;

        return (
          <Fragment key={step.id}>
            <li className="flex shrink-0 items-center">
              <button
                type="button"
                disabled={!isReached}
                onClick={() => onStepClick(step.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl p-1 text-left transition-opacity",
                  isReached ? "cursor-pointer hover:opacity-80" : "cursor-default"
                )}
                aria-current={isActive ? "step" : undefined}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                    isDone || isActive
                      ? "bg-[#1c1c1d] text-white"
                      : "border border-[rgba(28,28,29,0.2)] text-[rgba(28,28,29,0.5)]"
                  )}
                >
                  {isDone ? <Check className="h-4 w-4" /> : index + 1}
                </span>
                <span className="hidden flex-col md:flex">
                  <span
                    className={cn(
                      "text-sm font-medium leading-tight",
                      isActive ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.72)]"
                    )}
                  >
                    {step.title}
                  </span>
                  <span className="text-xs leading-tight text-[rgba(28,28,29,0.5)]">
                    {step.description}
                  </span>
                </span>
              </button>
            </li>
            {isLast ? null : (
              <span
                aria-hidden
                className={cn(
                  "mx-3 h-px min-w-6 flex-1",
                  index < currentIdx ? "bg-[rgba(28,28,29,0.4)]" : "bg-[rgba(28,28,29,0.12)]"
                )}
              />
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}
