"use client";

import { LanguagesIcon } from "lucide-react";
import { localeDisplayName, useSelectLocale } from "@/components/locale-selection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supportedLocales } from "@/i18n/config";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * The language button: the landing page's, and the previous design's dashboard header's. On the
 * new design the dashboard's choice lives in the account menu.
 */
export function LanguagePicker({ variant = "topbar" }: { variant?: "topbar" | "landing" }) {
  const locale = useLocale();
  const t = useTranslations();
  const selectLocale = useSelectLocale();
  const isLanding = variant === "landing";

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("Shared.dashboardShell.language")}
          aria-label={t("Shared.dashboardShell.language")}
          className={cn(
            "flex items-center justify-center outline-none transition-colors focus-visible:ring-2",
            isLanding
              ? "h-9 w-9 justify-center rounded-lg text-secondary hover:bg-fill-subtle hover:text-primary focus-visible:ring-border-strong"
              : "h-8 w-8 rounded-lg text-text-medium hover:bg-border-light hover:text-text-extra-high focus-visible:ring-border-medium"
          )}
        >
          <LanguagesIcon
            className={cn("shrink-0", isLanding ? "h-4 w-4" : "h-5 w-5")}
            strokeWidth={1.9}
          />
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
