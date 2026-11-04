"use client";

import { Select, SelectItem } from "@sdp/ui/select";
import type { ReactNode } from "react";
import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { localeDisplayName, useSelectLocale } from "@/components/locale-selection";
import { supportedLocales } from "@/i18n/config";
import { useLocale, useTranslations } from "@/i18n/provider";

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border-subtle py-3 last:border-b-0 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-body font-medium text-primary">{label}</p>
        <p className="text-meta text-secondary">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function AccountPreferences() {
  const t = useTranslations();
  const locale = useLocale();
  const selectLocale = useSelectLocale();

  return (
    <div className="@container flex w-full flex-col gap-2.5">
      <RecordSection title={t("Shared.account.preferences.languageTitle")}>
        <SettingRow
          label={t("Shared.account.preferences.dashboardLanguage")}
          hint={t("Shared.account.preferences.languageDescription")}
        >
          <Select
            ariaLabel={t("Shared.account.preferences.dashboardLanguage")}
            className="w-56"
            value={locale}
            onValueChange={(value) => {
              if (value !== null) {
                selectLocale(value);
              }
            }}
          >
            {supportedLocales.map((option) => (
              <SelectItem key={option} value={option}>
                {localeDisplayName(option, option)}
              </SelectItem>
            ))}
          </Select>
        </SettingRow>
      </RecordSection>
    </div>
  );
}
