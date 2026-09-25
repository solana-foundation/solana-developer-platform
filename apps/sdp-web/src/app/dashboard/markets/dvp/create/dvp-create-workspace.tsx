"use client";

import type { SolanaCluster } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { WizardFrame } from "@/components/wizard-frame";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import type { DvpCreateContext } from "./dvp-create.data";
import { PartiesStep } from "./dvp-create-parties-step";
import { ReviewStep } from "./dvp-create-review-step";
import { type DvpCreateForm, useDvpCreateForm } from "./use-dvp-create-form";

/** The wizard's stages, in the order the trade is actually decided. */
function useWizardSteps() {
  const t = useTranslations();
  return [
    {
      label: t("DashboardMarkets.dvp.stepParties"),
      title: t("DashboardMarkets.dvp.stepPartiesTitle"),
    },
    {
      label: t("DashboardMarkets.dvp.stepReview"),
      title: t("DashboardMarkets.dvp.stepReviewTitle"),
    },
  ] as const;
}

/**
 * The create flow, staged.
 *
 * Every other create flow in this product is a WizardFrame with a summary rail
 * and a review stage — counterparty, ramps, private channels. Staging puts WHO
 * before WHAT and gives the irreversible step somewhere to be reviewed, which
 * a trade that spends rent and publishes escrow addresses deserves.
 */
/** Whether each stage has been answered, in stage order. */
function stageAnswered(form: DvpCreateForm): boolean[] {
  // The parties stage answers everything `ready` asks except the expiry,
  // which belongs to the review step whose picker can clear it.
  return [form.readyIgnoringExpiry, form.ready];
}

/** Back, plus either Continue or the one irreversible button. */
function WizardFooter({
  canContinue,
  form,
  onBack,
  onContinue,
  onLastStep,
}: {
  canContinue: boolean;
  form: DvpCreateForm;
  onBack: () => void;
  onContinue: () => void;
  onLastStep: boolean;
}) {
  const t = useTranslations();

  return (
    <div className="flex items-center justify-between gap-3">
      <Button onClick={onBack} type="button" variant="secondary">
        {t("DashboardMarkets.dvp.wizardBack")}
      </Button>
      {onLastStep ? (
        <Button disabled={form.submitting || !form.ready} onClick={form.submit} type="button">
          {form.submitting
            ? t("DashboardMarkets.dvp.createSubmitting")
            : t("DashboardMarkets.dvp.createAction")}
        </Button>
      ) : (
        <Button disabled={!canContinue} onClick={onContinue} type="button">
          {t("DashboardMarkets.dvp.wizardContinue")}
        </Button>
      )}
    </div>
  );
}

/**
 * The form's terms were reviewed under one project; this is gone the moment the
 * shared selection moves to another one.
 *
 * Every wallet, token and counterparty the wizard shows was loaded for the
 * reviewed project, and the submit is bound to it server-side (APE-693), so a
 * form that keeps rendering after a switch would be a review of nothing. When
 * the live selection leaves the reviewed project the wizard is replaced: the
 * only way forward is re-rendering the page under the current project and
 * answering it again.
 */
function ProjectChangedNotice() {
  const t = useTranslations();
  const router = useRouter();

  return (
    <Callout variant="warning">
      <div className="flex flex-col gap-3">
        <p>{t("DashboardMarkets.dvp.projectChangedBody")}</p>
        <div>
          <Button onClick={() => router.refresh()} type="button" variant="secondary">
            {t("DashboardMarkets.dvp.projectChangedAction")}
          </Button>
        </div>
      </div>
    </Callout>
  );
}

export function DvpCreateWorkspace({
  cluster,
  context,
  reviewedProjectId,
}: {
  cluster: SolanaCluster;
  context: DvpCreateContext;
  /** The project the server rendered this form's context for. */
  reviewedProjectId: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const workspace = useOptionalDashboardWorkspace();
  const liveProjectId = workspace?.selectedProjectId ?? null;
  // Unknown (no provider, or the selection not loaded yet) never counts as a
  // change: only a KNOWN different project invalidates.
  const projectChanged = liveProjectId !== null && liveProjectId !== reviewedProjectId;
  const form = useDvpCreateForm(cluster, context, reviewedProjectId);
  const steps = useWizardSteps();
  const [step, setStep] = useState(0);

  const last = steps.length - 1;
  const canContinue = stageAnswered(form)[step];

  const body = [
    <PartiesStep context={context} form={form} key="parties" />,
    <ReviewStep form={form} key="review" />,
  ][step];

  const footer = (
    <WizardFooter
      canContinue={canContinue}
      form={form}
      // On the first step there is no earlier step; Back leaves the wizard for
      // the list it was entered from, so the button is never a silent no-op.
      onBack={() =>
        step === 0
          ? router.push(DASHBOARD_MARKETS_SUBNAV_HREFS.dvp)
          : setStep((current) => current - 1)
      }
      onContinue={() => setStep((current) => Math.min(last, current + 1))}
      onLastStep={step === last}
    />
  );

  if (projectChanged) {
    return <ProjectChangedNotice />;
  }

  return (
    <WizardFrame
      currentStep={step}
      description={t("DashboardMarkets.dvp.createDescription")}
      footer={footer}
      progressLabel={t("DashboardMarkets.dvp.wizardProgress", {
        current: String(step + 1),
        total: String(steps.length),
      })}
      steps={steps}
    >
      <div className="grid gap-5">
        {context.error ? <Callout variant="danger">{context.error}</Callout> : null}

        {cluster === "devnet" ? null : (
          <Callout variant="warning">
            {t("DashboardMarkets.dvp.wrongClusterWarning", { cluster })}
          </Callout>
        )}

        {body}

        {form.error ? (
          <Callout live variant="danger">
            {form.error}
          </Callout>
        ) : null}
      </div>
    </WizardFrame>
  );
}
