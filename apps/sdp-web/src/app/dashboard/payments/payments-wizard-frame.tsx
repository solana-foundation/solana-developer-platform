import type { ReactNode } from "react";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { cn } from "@/lib/utils";

interface PaymentsWizardFrameProps {
  children: ReactNode;
  currentStep: number;
  description?: ReactNode;
  footer: ReactNode;
  header?: ReactNode;
  maxWidthClassName?: string;
  progressLabel: string;
  steps: readonly { label: string; title: string }[];
}

export function PaymentsWizardFrame({
  children,
  currentStep,
  description,
  footer,
  header,
  maxWidthClassName = "max-w-3xl",
  progressLabel,
  steps,
}: PaymentsWizardFrameProps) {
  const activeStep = steps[currentStep];

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-payments-wizard-frame>
      <div className="shrink-0 px-4 pt-2 pb-6 md:px-6" data-payments-wizard-stepper>
        <div className={cn("mx-auto w-full", maxWidthClassName)}>
          <WizardStepProgress
            currentStep={currentStep}
            progressLabel={progressLabel}
            steps={steps.map((step) => step.label)}
          />
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6"
        data-payments-wizard-scroll-region
      >
        <div className={cn("mx-auto w-full pb-8", maxWidthClassName)}>
          <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0 space-y-1">
              <h2 className="text-2xl font-medium tracking-tight text-primary">
                {activeStep?.title}
              </h2>
              {description ? <div className="text-sm text-secondary">{description}</div> : null}
            </div>
            {header ? <div className="w-full shrink-0 sm:w-auto">{header}</div> : null}
          </div>
          {children}
        </div>
      </div>

      <footer
        className="shrink-0 border-t border-border-default bg-surface-raised/95 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6"
        data-payments-wizard-actions
      >
        <div className={cn("mx-auto w-full", maxWidthClassName)}>{footer}</div>
      </footer>
    </div>
  );
}
