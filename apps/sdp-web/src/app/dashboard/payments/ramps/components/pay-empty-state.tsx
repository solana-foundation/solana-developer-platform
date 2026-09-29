"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import type { PayEmptyReason } from "./pay-readiness";

const EMPTY_STEP = [{ label: "", title: "" }];

/**
 * Pay before the project can pay anyone: the design's empty state in the flow's frame, centred
 * between the tabs and a footer band whose only action is the way back. The actions point at
 * what is missing: a contact, a deposit, or both.
 */
export function PayEmptyState({ reason, onExit }: { reason: PayEmptyReason; onExit: () => void }) {
  const t = useTranslations();
  const addContact = (
    <Button asChild variant="outline">
      <Link href="/dashboard/payments/counterparty/create">
        {t("DashboardPayments.payForm.addContact")}
      </Link>
    </Button>
  );
  const depositFirst = (
    <Button asChild variant={reason === "no_funds" ? "outline" : "ghost"}>
      <Link href="/dashboard/payments/deposit">{t("DashboardPayments.payForm.depositFirst")}</Link>
    </Button>
  );
  const message =
    reason === "no_funds"
      ? t("DashboardPayments.payForm.nothingToPayWithTitle")
      : t("DashboardPayments.payForm.nobodyToPayTitle");
  const description =
    reason === "neither"
      ? t("DashboardPayments.payForm.nobodyToPayNeither")
      : reason === "no_contact"
        ? t("DashboardPayments.payForm.nobodyToPayNoContact")
        : t("DashboardPayments.payForm.nothingToPayWithDescription");

  return (
    <WizardFrame
      steps={EMPTY_STEP}
      currentStep={0}
      progressLabel=""
      hideProgress
      fillHeight
      footer={
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onExit}>
            {t("Shared.dashboardShell.backToPayments")}
          </Button>
        </div>
      }
    >
      <ListEmptyState
        className="refresh:flex-1 refresh:justify-center refresh:py-0"
        message={message}
        description={description}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {reason === "no_funds" ? null : addContact}
            {reason === "no_contact" ? null : depositFirst}
          </div>
        }
      />
    </WizardFrame>
  );
}
