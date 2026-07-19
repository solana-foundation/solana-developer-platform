"use client";

import { ArrowLeftIcon, ArrowRightIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { useCounterpartyCreate } from "../counterparty-create-context";

interface StepFooterProps {
  onCancel?: () => void;
}

export function StepFooter({ onCancel }: StepFooterProps) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const { step, currentStepId, goNext, goBack, submit, submitting } = useCounterpartyCreate();

  const isFirst = step === 0;
  const isReview = currentStepId === "review";
  const cancel = onCancel ?? (() => router.push("/dashboard/payments/counterparty"));

  return (
    <div className="flex items-center justify-between gap-3">
      <Button
        type="button"
        variant="secondary"
        onClick={isFirst ? cancel : goBack}
        disabled={submitting}
        iconLeft={isFirst ? undefined : <ArrowLeftIcon />}
      >
        {isFirst
          ? t("DashboardPayments.counterparty.cancel")
          : t("DashboardPayments.counterparty.back")}
      </Button>

      {isReview ? (
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
      ) : (
        <Button type="button" onClick={goNext} iconRight={<ArrowRightIcon />}>
          {t("DashboardPayments.counterparty.next")}
        </Button>
      )}
    </div>
  );
}
