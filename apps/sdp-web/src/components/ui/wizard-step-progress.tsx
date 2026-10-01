import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

interface WizardStepProgressProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  currentStep: number;
  progressLabel: string;
  steps: readonly string[];
}

export function WizardStepProgress({
  className,
  currentStep,
  progressLabel,
  steps,
  ...props
}: WizardStepProgressProps) {
  return (
    <div
      {...props}
      className={cn("flex shrink-0 items-center gap-4", className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {steps.map((step, index) => (
          <span
            key={step}
            className={cn(
              "h-1.5 rounded-full transition-[width,background-color] duration-200 motion-reduce:transition-none",
              index === currentStep
                ? "w-5 bg-primary"
                : index < currentStep
                  ? "w-2.5 bg-primary"
                  : "w-2.5 bg-fill-strong"
            )}
          />
        ))}
      </div>
      <span className="text-xs text-muted">{progressLabel}</span>
    </div>
  );
}
