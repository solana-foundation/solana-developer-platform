"use client";

import { cn } from "@sdp/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { LanguagesIcon } from "lucide-react";
import { localeDisplayName, useSelectLocale } from "@/components/locale-selection";
import { supportedLocales } from "@/i18n/config";
import { useLocale, useTranslations } from "@/i18n/provider";

/**
 * The language button: the landing page's. The dashboard's choice lives in the account menu.
 */
export function LanguagePicker() {
  const locale = useLocale();
  const t = useTranslations();
  const selectLocale = useSelectLocale();

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("Shared.dashboardShell.language")}
          aria-label={t("Shared.dashboardShell.language")}
          className={cn(
            "flex items-center justify-center outline-none transition-colors focus-visible:ring-2",
            "h-9 w-9 justify-center rounded-lg text-secondary hover:bg-fill-subtle hover:text-primary focus-visible:ring-border-strong"
          )}
        >
          <LanguagesIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={8} className="w-64 p-2">
        <DropdownMenuLabel className="px-2 py-1">
          {t("Shared.dashboardShell.chooseLanguage")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={locale} onValueChange={selectLocale}>
          {supportedLocales.map((supportedLocale) => (
            <DropdownMenuRadioItem
              key={supportedLocale}
              value={supportedLocale}
              className="pl-2.5 data-[state=checked]:bg-border-light data-[state=checked]:font-semibold [&>span:first-child]:hidden"
            >
              <span>{localeDisplayName(supportedLocale, supportedLocale)}</span>
              <span className="ml-auto text-xs font-normal tracking-wide text-text-extra-low uppercase">
                {supportedLocale}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs leading-4 text-text-extra-low">
          {t("Shared.dashboardShell.moreLanguagesHint")}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
