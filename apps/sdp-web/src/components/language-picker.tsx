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

/** A language named in itself: "English", "Français". */
export function localeDisplayName(locale: AppLocale, displayLocale: AppLocale): string {
  const name = getDisplayNames(displayLocale).of(locale) ?? locale;
  return name.charAt(0).toLocaleUpperCase(displayLocale) + name.slice(1);
}

/** Switches the interface language: stores the choice for the server and re-renders in it. */
export function useSelectLocale(): (value: string) => void {
  const locale = useLocale();
  const router = useRouter();

  return (value: string) => {
    if (!isAppLocale(value) || value === locale) return;

    // biome-ignore lint/suspicious/noDocumentCookie: The server locale resolver needs this preference on the next request.
    document.cookie = `${localeCookieName}=${encodeURIComponent(value)}; Path=/; Max-Age=${localeCookieMaxAgeSeconds}; SameSite=Lax; Secure`;
    document.documentElement.lang = value;
    router.refresh();
  };
}

/** The landing page's language button; in the dashboard the choice lives in the account menu. */
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
          className="flex h-9 w-9 items-center justify-center rounded-lg text-secondary outline-none transition-colors hover:bg-fill-subtle hover:text-primary focus-visible:ring-2 focus-visible:ring-border-strong"
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
