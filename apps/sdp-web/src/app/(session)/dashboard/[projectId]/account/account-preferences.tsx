"use client";

import { Select, SelectItem } from "@sdp/ui/select";
import {
  RecordActionRow,
  RecordSection,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { localeDisplayName, useSelectLocale } from "@/components/locale-selection";
import { supportedLocales } from "@/i18n/config";
import { useLocale, useTranslations } from "@/i18n/provider";

export function AccountPreferences() {
  const t = useTranslations();
  const locale = useLocale();
  const selectLocale = useSelectLocale();

  return (
    <div className="@container flex w-full flex-col gap-2.5">
      <RecordSection title={t("Shared.account.preferences.languageTitle")}>
        <RecordActionRow
          label={t("Shared.account.preferences.dashboardLanguage")}
          hint={t("Shared.account.preferences.languageDescription")}
          control={
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
          }
        />
      </RecordSection>
    </div>
  );
}
