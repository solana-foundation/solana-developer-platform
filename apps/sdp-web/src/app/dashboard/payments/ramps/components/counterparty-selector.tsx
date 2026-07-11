"use client";

import { UsersIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import { useTranslations } from "@/i18n/provider";
import type { CounterpartiesResult } from "../../payments-workspace.data";

interface CounterpartySelectorProps {
  counterpartiesResult: CounterpartiesResult;
  value: string | null;
  onChange: (counterpartyId: string) => void;
}

export function CounterpartySelector({
  counterpartiesResult,
  value,
  onChange,
}: CounterpartySelectorProps) {
  const t = useTranslations();
  const options = useMemo(
    () =>
      counterpartiesResult.data
        .filter((cp) => cp.status === "active")
        .map((cp) => ({ value: cp.id, label: cp.displayName, description: cp.email })),
    [counterpartiesResult.data]
  );

  return (
    <Combobox
      label={t("DashboardPayments.counterpartyLabel")}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={t("DashboardPayments.ramps.selectCounterparty")}
      searchPlaceholder={t("DashboardPayments.ramps.searchCounterparties")}
      variant="dialog"
      icon={<UsersIcon className="size-5 shrink-0 text-text-low" />}
      error={
        counterpartiesResult.ok
          ? undefined
          : (counterpartiesResult.error ?? t("DashboardPayments.ramps.counterpartiesLoadFailed"))
      }
    />
  );
}
