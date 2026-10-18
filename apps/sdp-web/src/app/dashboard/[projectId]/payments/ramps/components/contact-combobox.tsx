"use client";

import { Combobox } from "@sdp/ui/combobox";
import { InfoHint } from "@sdp/ui/info-hint";
import { useThemeScope } from "@sdp/ui/theme-scope";
import { type ReactNode, useMemo } from "react";
import type { CounterpartiesResult } from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";

export interface ContactControls {
  counterpartiesResult: CounterpartiesResult;
  onChange: (counterpartyId: string) => void;
}

/**
 * The "Contact" field Pay and Deposit open with: active contacts, searchable. Outside a refresh
 * surface the label carries a hint and each contact its type; the design's label stands alone
 * and its list names the contacts only.
 */
export function ContactCombobox({
  counterpartiesResult,
  onChange,
  value,
  hint,
  footer,
}: ContactControls & {
  value: string;
  hint: string;
  /** Rendered under the list, e.g. a "New contact" action; called with a function that closes it. */
  footer?: (close: () => void) => ReactNode;
}) {
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  const options = useMemo(
    () =>
      counterpartiesResult.data
        .filter((counterparty) => counterparty.status === "active")
        .map((counterparty) => ({
          value: counterparty.id,
          label: counterparty.displayName,
          // The design lists contacts by name alone.
          description: refresh
            ? undefined
            : t(`DashboardPayments.counterparty.${counterparty.entityType}`),
        })),
    [counterpartiesResult.data, refresh, t]
  );
  return (
    <Combobox
      label={t("DashboardPayments.payForm.contact")}
      labelAccessory={refresh ? undefined : <InfoHint text={hint} />}
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
