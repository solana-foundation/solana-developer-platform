"use client";

import { useMemo } from "react";
import { useThemeScope } from "@/components/theme-scope";
import { Combobox } from "@/components/ui/combobox";
import { InfoHint } from "@/components/ui/info-hint";
import { useTranslations } from "@/i18n/provider";
import type { CounterpartiesResult } from "../../payments-workspace.data";

export interface ContactControls {
  counterpartiesResult: CounterpartiesResult;
  onChange: (counterpartyId: string) => void;
}

/**
 * The "Contact" field Pay and Deposit open with: active contacts, searchable. Outside a refresh
 * surface the label carries a hint; the design's label stands alone.
 */
export function ContactCombobox({
  counterpartiesResult,
  onChange,
  value,
  hint,
}: ContactControls & { value: string; hint: string }) {
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  const options = useMemo(
    () =>
      counterpartiesResult.data
        .filter((counterparty) => counterparty.status === "active")
        .map((counterparty) => ({
          value: counterparty.id,
          label: counterparty.displayName,
          description: t(`DashboardPayments.counterparty.${counterparty.entityType}`),
        })),
    [counterpartiesResult.data, t]
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
      error={
        counterpartiesResult.ok
          ? undefined
          : (counterpartiesResult.error ?? t("DashboardPayments.ramps.counterpartiesLoadFailed"))
      }
    />
  );
}
