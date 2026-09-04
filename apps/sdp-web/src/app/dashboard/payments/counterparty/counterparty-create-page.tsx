"use client";

import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import { useCounterpartyCreate } from "./counterparty-create-context";
import { CryptoAccountsPhase } from "./crypto-accounts-phase";
import { BasicsStep } from "./steps/basics-step";

interface CounterpartyCreatePageProps {
  embedded?: boolean;
  onCancel?: () => void;
}

export function CounterpartyCreatePage({
  embedded = false,
  onCancel,
}: CounterpartyCreatePageProps) {
  const t = useTranslations();
  const router = useRouter();
  const { submit, submitting, submitError, createdCounterparty } = useCounterpartyCreate();

  const wizardSteps = [
    {
      label: t("DashboardPayments.counterparty.basics"),
      title: t("DashboardPayments.counterparty.basicInfo"),
    },
    {
      label: t("DashboardPayments.counterparty.cryptoWallet"),
      title: t("DashboardPayments.counterparty.addCryptoAccount"),
    },
  ];

  if (createdCounterparty) {
    return <CryptoAccountsPhase embedded={embedded} steps={wizardSteps} />;
  }

  const cancel = onCancel ?? (() => router.push("/dashboard/payments/counterparty"));

  const content = (
    <div className="space-y-6">
      <BasicsStep />
      {submitError ? <p className="text-sm text-error">{submitError}</p> : null}
    </div>
  );

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <Button type="button" variant="secondary" onClick={cancel} disabled={submitting}>
        {t("DashboardPayments.counterparty.cancel")}
      </Button>
      <Button
        type="button"
        onClick={submit}
        disabled={submitting}
        iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
      >
        {submitting
          ? t("DashboardPayments.counterparty.creating")
          : t("DashboardPayments.counterparty.create")}
      </Button>
    </div>
  );

  if (embedded) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h2 className="text-2xl font-medium tracking-tight text-primary">
            {t("DashboardPayments.counterparty.basicInfo")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardPayments.counterparty.basicInfoDescription")}
          </p>
        </div>
        {content}
        {footer}
      </div>
    );
  }

  return (
    <WizardFrame
      steps={wizardSteps}
      currentStep={0}
      progressLabel={t("DashboardPayments.counterparty.stepProgress", {
        current: 1,
        total: wizardSteps.length,
      })}
      description={t("DashboardPayments.counterparty.basicInfoDescription")}
      footer={footer}
      maxWidthClassName="max-w-xl"
    >
      {content}
    </WizardFrame>
  );
}
