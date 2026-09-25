import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

interface WizardStepProgressProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  currentStep: number;
  progressLabel: string;
  steps: readonly string[];
}

/**
 * Where a wizard is. Base surfaces draw one pill per step beside "Step x of y"; a refresh
 * surface names the current step, puts "Step x of y" opposite it and fills a continuous bar
 * underneath. CSS picks the layout, so this stays usable from server components. Only
 * "Step x of y" is the live region; the step name and the drawing are visual.
 */
export function WizardStepProgress({
  className,
  currentStep,
  progressLabel,
  steps,
  ...props
}: WizardStepProgressProps) {
  const filled = steps.length === 0 ? 0 : ((currentStep + 1) / steps.length) * 100;
  return (
    <div
      {...props}
      className={cn(
        "flex shrink-0 items-center gap-4",
        "refresh:grid refresh:w-full refresh:grid-cols-[minmax(0,1fr)_auto] refresh:items-baseline refresh:gap-x-4 refresh:gap-y-2",
        className
      )}
    >
      <div className="flex items-center gap-1.5 refresh:hidden" aria-hidden="true">
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
      <span
        className="hidden truncate text-body font-medium text-primary refresh:block"
        aria-hidden="true"
      >
        {steps[currentStep]}
      </span>
      <span
        className="text-xs text-muted refresh:text-meta refresh:text-tertiary"
        role="status"
        aria-live="polite"
      >
        {progressLabel}
      </span>
      <div
        className="hidden h-1 overflow-hidden rounded-full bg-fill-strong refresh:col-span-2 refresh:block"
        aria-hidden="true"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${filled}%` }}
        />
      </div>
    </div>
  );
}
