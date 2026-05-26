import { cn } from "@/lib/utils";
import type { StepId } from "../counterparty-create-schemas";

interface StepIndicatorProps {
  steps: StepId[];
  step: number;
}

export function StepIndicator({ steps, step }: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        {steps.map((s, i) => (
          <div
            key={s}
            className={cn(
              "h-1.5 rounded-full transition-all duration-200",
              i === step
                ? "w-4 bg-gray-1400"
                : i < step
                  ? "w-1.5 bg-gray-1400"
                  : "w-1.5 bg-border-light"
            )}
          />
        ))}
      </div>
      <span className="text-xs text-text-extra-low">
        Step {step + 1} of {steps.length}
      </span>
    </div>
  );
}
