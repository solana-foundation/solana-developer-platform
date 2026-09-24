"use client";

import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import { InfoHint } from "@/components/ui/info-hint";
import { useTranslations } from "@/i18n/provider";
import type { CounterpartiesResult } from "../../payments-workspace.data";

export interface ContactControls {
  counterpartiesResult: CounterpartiesResult;
  onChange: (counterpartyId: string) => void;
}

/** The "Contact" field Pay and Deposit open with: active contacts, searchable, with a hint. */
export function ContactCombobox({
  counterpartiesResult,
  onChange,
  value,
  hint,
}: ContactControls & { value: string; hint: string }) {
  const t = useTranslations();
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
      labelAccessory={<InfoHint text={hint} />}
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
