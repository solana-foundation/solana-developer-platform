"use client";

import { Combobox } from "@sdp/ui/combobox";
import { type ReactNode, useMemo } from "react";
import type { CounterpartiesResult } from "@/app/(session)/dashboard/[projectId]/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";

export interface ContactControls {
  counterpartiesResult: CounterpartiesResult;
  onChange: (counterpartyId: string) => void;
}

/**
 * The "Contact" field Pay and Deposit open with: active contacts, searchable, listed by name
 * alone as the design does.
 */
export function ContactCombobox({
  counterpartiesResult,
  onChange,
  value,
  footer,
}: ContactControls & {
  value: string;
  /** Rendered under the list, e.g. a "New contact" action; called with a function that closes it. */
  footer?: (close: () => void) => ReactNode;
}) {
  const t = useTranslations();
  const options = useMemo(
    () =>
      counterpartiesResult.data
        .filter((counterparty) => counterparty.status === "active")
        .map((counterparty) => ({ value: counterparty.id, label: counterparty.displayName })),
    [counterpartiesResult.data]
  );
  return (
    <Combobox
      label={t("DashboardPayments.payForm.contact")}
      value={value === "" ? null : value}
      onChange={onChange}
      options={options}
      placeholder={t("DashboardPayments.payForm.selectContact")}
      searchPlaceholder={t("DashboardPayments.payForm.searchContacts")}
      footer={footer}
      error={
        counterpartiesResult.ok
          ? undefined
          : (counterpartiesResult.error ?? t("DashboardPayments.ramps.counterpartiesLoadFailed"))
      }
    />
  );
}
