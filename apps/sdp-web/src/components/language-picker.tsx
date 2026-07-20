"use client";

import { LanguagesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AppLocale, isAppLocale, localeCookieName, supportedLocales } from "@/i18n/config";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const localeCookieMaxAgeSeconds = 60 * 60 * 24 * 365;

const displayNamesCache = new Map<AppLocale, Intl.DisplayNames>();

function getDisplayNames(displayLocale: AppLocale): Intl.DisplayNames {
  let dn = displayNamesCache.get(displayLocale);
  if (!dn) {
    dn = new Intl.DisplayNames([displayLocale], { type: "language" });
    displayNamesCache.set(displayLocale, dn);
  }
  return dn;
}

function localeDisplayName(locale: AppLocale, displayLocale: AppLocale): string {
  return getDisplayNames(displayLocale).of(locale) ?? locale;
}

export function LanguagePicker({ variant = "topbar" }: { variant?: "topbar" | "landing" }) {
  const locale = useLocale();
  const t = useTranslations();
  const router = useRouter();
  const isLanding = variant === "landing";

  const selectLocale = (value: string) => {
    if (!isAppLocale(value) || value === locale) return;

    // biome-ignore lint/suspicious/noDocumentCookie: The server locale resolver needs this preference on the next request.
    document.cookie = `${localeCookieName}=${encodeURIComponent(value)}; Path=/; Max-Age=${localeCookieMaxAgeSeconds}; SameSite=Lax; Secure`;
    document.documentElement.lang = value;
    router.refresh();
  };

  return (
    <DropdownMenu>
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
