"use client";

import { cn } from "@sdp/ui/cn";
import { Modal } from "@sdp/ui/modal";
import { WizardStepProgress } from "@sdp/ui/wizard-step-progress";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { useStepFade } from "@/lib/use-step-fade";

interface WizardFrameProps {
  /** Persistent right-hand rail rendered beside the step content on large screens. */
  aside?: ReactNode;
  children: ReactNode;
  currentStep: number;
  currentStepTitle?: string;
  description?: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
  /** Omit the step header, for a single-page form such as a settings page. */
  hideProgress?: boolean;
  /**
   * Let the content fill the column's height (a `flex-1` child then centres in it), for a state
   * that stands alone in the frame.
   */
  fillHeight?: boolean;
  progressLabel: string;
  /** Selection recap opened from the "View summary" button in a modal. */
  summary?: ReactNode;
  /** Replaces the "View summary" button text (e.g. a provider-branded chip). */
  summaryTrigger?: ReactNode;
  steps: readonly { label: string; title: string }[];
  titleBadge?: ReactNode;
  /** Actions rendered to the right of the step progress indicator. */
  toolbarActions?: ReactNode;
}

/**
 * The actions at the end of the heading row: the step's own header content, then the
 * "View summary" button once there is a selection to recap.
 */
function WizardHeadingActions({
  header,
  showSummaryButton,
  hasTitleBadge,
  summaryTrigger,
  onOpenSummary,
}: {
  header?: ReactNode;
  showSummaryButton: boolean;
  hasTitleBadge: boolean;
  summaryTrigger?: ReactNode;
  onOpenSummary: () => void;
}) {
  const t = useTranslations();
  if (!(header || showSummaryButton)) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex w-full shrink-0 items-center gap-3 sm:w-auto",
        hasTitleBadge && "justify-center sm:col-start-3 sm:justify-self-end"
      )}
    >
      {header}
      {header && showSummaryButton ? (
        <span aria-hidden className="h-4 w-px bg-border-default" />
      ) : null}
      {showSummaryButton ? (
        <button
          type="button"
          onClick={onOpenSummary}
          aria-label={t("DashboardPayments.viewSummary")}
          className="flex items-center gap-1.5 text-sm font-medium text-secondary underline-offset-4 hover:text-primary hover:underline"
        >
          {summaryTrigger ?? t("DashboardPayments.viewSummary")}
        </button>
      ) : null}
    </div>
  );
}

/** The step's heading row: its title and badge, the description, and the heading actions. */
function WizardStepHeading({
  title,
  titleBadge,
  description,
  header,
  showSummaryButton,
  summaryTrigger,
  onOpenSummary,
}: {
  title: string;
  titleBadge?: ReactNode;
  description?: ReactNode;
  header?: ReactNode;
  showSummaryButton: boolean;
  summaryTrigger?: ReactNode;
  onOpenSummary: () => void;
}) {
  const hasTitleBadge = Boolean(titleBadge);
  // A step can leave the title empty when its step header already names it; the heading row
  // then collapses instead of leaving a gap.
  const titleRowEmpty = !title && !header && !showSummaryButton && !hasTitleBadge;

  return (
    <div
      data-wizard-heading
      className={cn(
        "mb-6 gap-3 sm:gap-4",
        titleRowEmpty && "sr-only",
        hasTitleBadge
          ? "grid grid-cols-1 items-center text-center sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
          : "flex flex-col items-start sm:flex-row sm:items-center sm:justify-between"
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-heading font-medium tracking-tight text-primary">{title}</h2>
          {titleBadge}
        </div>
        {description ? <div className="text-body text-secondary">{description}</div> : null}
      </div>
      <WizardHeadingActions
        header={header}
        showSummaryButton={showSummaryButton}
        hasTitleBadge={hasTitleBadge}
        summaryTrigger={summaryTrigger}
        onOpenSummary={onOpenSummary}
      />
    </div>
  );
}

/** The step content, beside the persistent right-hand rail on large screens when there is one. */
function WizardStepBody({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return aside ? (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_440px]">
      <main className="min-w-0">{children}</main>
      {aside}
    </div>
  ) : (
    children
  );
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
  currentStepTitle,
  description,
  footer,
  header,
  hideProgress = false,
  fillHeight = false,
  progressLabel,
  summary,
  summaryTrigger,
  steps,
  titleBadge,
  toolbarActions,
}: WizardFrameProps) {
  const t = useTranslations();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const lastStepRef = useRef(currentStep);
  const stepRef = useStepFade<HTMLDivElement>(currentStep);
  // A new step opens at its top. The column keeps its own scroll offset otherwise, so a tall
  // step after a scrolled one would open mid-form with its heading out of view.
  useLayoutEffect(() => {
    if (lastStepRef.current === currentStep) return;
    lastStepRef.current = currentStep;
    // Assigning scrollTop works in every environment, jsdom included; scrollTo does not.
    const region = scrollRegionRef.current;
    if (region !== null) region.scrollTop = 0;
  }, [currentStep]);
  const activeStep = steps[currentStep];
  const showSummaryButton = summary !== undefined && currentStep > 0;

  // A fill-height step's `flex-1` content still sits in a flex column through this wrapper.
  const stepContent = (
    <div ref={stepRef} className={cn(fillHeight && "flex flex-1 flex-col")} data-wizard-step>
      <WizardStepBody aside={aside}>
        <WizardStepHeading
          title={currentStepTitle ?? activeStep.title}
          titleBadge={titleBadge}
          description={description}
          header={header}
          showSummaryButton={showSummaryButton}
          summaryTrigger={summaryTrigger}
          onOpenSummary={() => setSummaryOpen(true)}
        />
        {children}
      </WizardStepBody>
    </div>
  );

  const summaryModal =
    summary === undefined ? null : (
      <Modal
        isOpen={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        ariaLabel={t("DashboardPayments.wizardSummaryTitle")}
        size="sm"
      >
        <div className="p-6">{summary}</div>
      </Modal>
    );

  // The flow is one column in the shell's gutter: 36px under the title or tabs, the step header,
  // 48px, the content, then a footer band across the bottom of the page on the sidebar's paper (a
  // step darker than the page in both themes, as the design draws it). The column scrolls on its
  // own when a step outgrows the viewport; the band stays put. The shell section has no padding,
  // so the band reaches the edges as it is.
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-wizard-frame>
      <div
        ref={scrollRegionRef}
        // Scrolled content fades out under the title and tabs instead of being cut mid-line.
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-9 pb-10 [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)] md:px-6"
        data-wizard-scroll-region
      >
        <div className={cn("mx-auto w-full max-w-flow", fillHeight && "flex min-h-full flex-col")}>
          <div
            className={cn("mb-12 flex items-start gap-3", hideProgress && "hidden")}
            data-wizard-stepper
          >
            <WizardStepProgress
              className="min-w-0 flex-1"
              currentStep={currentStep}
              progressLabel={progressLabel}
              steps={steps.map((step) => step.label)}
            />
            {toolbarActions}
          </div>
          {stepContent}
        </div>
      </div>
      {footer ? (
        <footer
          className="shrink-0 border-t border-border-subtle bg-surface px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6"
          data-wizard-actions
        >
          <div className="mx-auto w-full max-w-flow">{footer}</div>
        </footer>
      ) : null}
      {summaryModal}
    </div>
  );
}
