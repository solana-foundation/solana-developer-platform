import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";

interface WizardStepProgressProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  currentStep: number;
  progressLabel: string;
  steps: readonly string[];
}

/**
 * Where a wizard is: the current step's name, "Step x of y" opposite it, and a continuous bar
 * underneath. The live region reads the step's name with "Step x of y"; the drawn name and the
 * bar are visual.
 */
export function WizardStepProgress({
  className,
  currentStep,
  progressLabel,
  steps,
  ...props
}: WizardStepProgressProps) {
  const filled = steps.length === 0 ? 0 : ((currentStep + 1) / steps.length) * 100;
  const stepName = steps[currentStep];
  return (
    <div
      {...props}
      className={cn(
        "grid w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2",
        className
      )}
    >
      <span className="block truncate text-body font-medium text-primary" aria-hidden="true">
        {stepName}
      </span>
      <span className="text-meta text-tertiary" role="status" aria-live="polite">
        {/* A step change announces where the reader now is, as well as how far along. The
            label keeps its own element, so it still matches as "Step x of y" alone. */}
        {stepName === undefined ? null : <span className="sr-only">{`${stepName}, `}</span>}
        <span>{progressLabel}</span>
      </span>
      <div
        className="col-span-2 block h-1 overflow-hidden rounded-full bg-fill-strong"
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
