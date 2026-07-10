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
                ? "w-4 bg-primary"
                : i < step
                  ? "w-1.5 bg-primary"
                  : "w-1.5 bg-fill-strong"
            )}
          />
        ))}
      </div>
      <span className="text-xs text-muted">
        Step {step + 1} of {steps.length}
      </span>
    </div>
  );
}
