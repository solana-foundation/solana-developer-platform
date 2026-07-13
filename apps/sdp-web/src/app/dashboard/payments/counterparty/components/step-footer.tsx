"use client";

import { ArrowLeftIcon, ArrowRightIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { useCounterpartyCreate } from "../counterparty-create-context";

export function StepFooter() {
  const t = useTranslations();
  const { step, currentStepId, goNext, goBack, submit, submitting } = useCounterpartyCreate();

  const isFirst = step === 0;
  const isReview = currentStepId === "review";

  return (
    <div className="flex items-center justify-between gap-3">
      {isFirst ? (
        <span />
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={goBack}
          disabled={submitting}
          iconLeft={<ArrowLeftIcon />}
        >
          {t("DashboardPayments.counterparty.back")}
        </Button>
      )}

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
