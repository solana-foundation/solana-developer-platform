"use client";

import { Button } from "@sdp/ui/button";
import { Combobox } from "@sdp/ui/combobox";
import { type ReactNode, useMemo } from "react";
import type { CounterpartiesResult } from "@/app/(session)/dashboard/[projectId]/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";

export interface ContactControls {
  counterpartiesResult: CounterpartiesResult;
  /** The contacts are still being read: the field waits, empty, rather than offering none. */
  loading: boolean;
  onRetry: () => void;
  onChange: (counterpartyId: string) => void;
}

/**
 * The "Contact" field Pay and Deposit open with: active contacts, searchable, listed by name
 * alone as the design does.
 */
export function ContactCombobox({
  counterpartiesResult,
  loading,
  onRetry,
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
    <div className="flex flex-col gap-2">
      <Combobox
        label={t("DashboardPayments.payForm.contact")}
        value={value === "" ? null : value}
        onChange={onChange}
        options={options}
        placeholder={t("DashboardPayments.payForm.selectContact")}
        searchPlaceholder={t("DashboardPayments.payForm.searchContacts")}
        footer={footer}
        isLoading={loading}
        disabled={loading}
        error={
          counterpartiesResult.ok
            ? undefined
            : (counterpartiesResult.error ?? t("DashboardPayments.ramps.counterpartiesLoadFailed"))
        }
      />
      {counterpartiesResult.ok ? null : (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onRetry}>
          {t("Shared.SharedComponents.retry")}
        </Button>
      )}
    </div>
  );
}
