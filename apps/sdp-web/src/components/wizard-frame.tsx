"use client";

import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

interface WizardFrameProps {
  /** Persistent right-hand rail rendered beside the step content on large screens. */
  aside?: ReactNode;
  children: ReactNode;
  currentStep: number;
  description?: ReactNode;
  footer: ReactNode;
  header?: ReactNode;
  maxWidthClassName?: string;
  progressLabel: string;
  /** Selection recap opened from the "View summary" button in a modal. */
  summary?: ReactNode;
  steps: readonly { label: string; title: string }[];
  /** Actions rendered to the right of the step progress indicator. */
  toolbarActions?: ReactNode;
}

/**
 * Renders shared payments wizard progress, content, and footer chrome.
 *
 * @param props - Wizard content, progress state, optional summary, and actions.
 * @returns The payments wizard frame.
 */
export function WizardFrame({
  aside,
  children,
  currentStep,
  description,
  footer,
  header,
  maxWidthClassName = "max-w-3xl",
  progressLabel,
  summary,
  steps,
  toolbarActions,
}: WizardFrameProps) {
  const t = useTranslations();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const activeStep = steps[currentStep];
  const showSummaryButton = summary !== undefined && currentStep > 0;

  const stepContent = (
    <>
      <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-2xl font-medium tracking-tight text-primary">{activeStep.title}</h2>
          {description ? <div className="text-sm text-secondary">{description}</div> : null}
        </div>
        {header || showSummaryButton ? (
          <div className="flex w-full shrink-0 items-center gap-3 sm:w-auto">
            {header}
            {showSummaryButton ? (
              <Button type="button" variant="ghost" onClick={() => setSummaryOpen(true)}>
                {t("DashboardPayments.viewSummary")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {children}
    </>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-wizard-frame>
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6" data-wizard-stepper>
        <div
          className={cn(
            "mx-auto flex w-full flex-wrap items-center justify-between gap-3",
            maxWidthClassName
          )}
        >
          <WizardStepProgress
            currentStep={currentStep}
            progressLabel={progressLabel}
            steps={steps.map((step) => step.label)}
          />
          {toolbarActions}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6" data-wizard-scroll-region>
        <div className={cn("mx-auto w-full pb-8", maxWidthClassName)}>
          {aside ? (
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_440px]">
              <main className="min-w-0">{stepContent}</main>
              {aside}
            </div>
          ) : (
            stepContent
          )}
        </div>
      </div>

      <footer
        className="shrink-0 border-t border-border-default px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6"
        data-wizard-actions
      >
        <div className={cn("mx-auto w-full", maxWidthClassName)}>{footer}</div>
      </footer>

      {summary === undefined ? null : (
        <Modal
          isOpen={summaryOpen}
          onClose={() => setSummaryOpen(false)}
          ariaLabel={t("DashboardPayments.wizardSummaryTitle")}
          size="sm"
        >
          <div className="p-6">{summary}</div>
        </Modal>
      )}
    </div>
  );
}
