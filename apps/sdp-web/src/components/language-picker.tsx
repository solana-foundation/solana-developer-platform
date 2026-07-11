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

function localeDisplayName(locale: AppLocale, displayLocale: AppLocale): string {
  return new Intl.DisplayNames([displayLocale], { type: "language" }).of(locale) ?? locale;
}

export function LanguagePicker({ collapsed = false }: { collapsed?: boolean }) {
  const locale = useLocale();
  const t = useTranslations();
  const router = useRouter();
  const currentLocaleName = localeDisplayName(locale, locale);

  const selectLocale = (value: string) => {
    if (!isAppLocale(value) || value === locale) return;

    // biome-ignore lint/suspicious/noDocumentCookie: The server locale resolver needs this preference on the next request.
    document.cookie = `${localeCookieName}=${encodeURIComponent(value)}; Path=/; Max-Age=${localeCookieMaxAgeSeconds}; SameSite=Lax`;
    document.documentElement.lang = value;
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={collapsed ? t("Shared.dashboardShell.language") : undefined}
          aria-label={collapsed ? t("Shared.dashboardShell.language") : undefined}
          className={cn(
            "group flex h-10 w-full items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-base text-text-medium outline-none transition-colors hover:bg-border-light hover:text-text-extra-high focus-visible:ring-2 focus-visible:ring-border-medium",
            collapsed && "justify-center"
          )}
        >
          <LanguagesIcon className="h-5 w-5 shrink-0" strokeWidth={1.9} />
          {collapsed ? null : (
            <>
              <span className="whitespace-nowrap">{t("Shared.dashboardShell.language")}</span>
              <span className="ml-auto max-w-28 truncate text-xs text-text-extra-low transition-colors group-hover:text-text-low">
                {currentLocaleName}
              </span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-64 p-2">
        <DropdownMenuLabel className="px-2 py-1">
          {t("Shared.dashboardShell.chooseLanguage")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={locale} onValueChange={selectLocale}>
          {supportedLocales.map((supportedLocale) => (
            <DropdownMenuRadioItem key={supportedLocale} value={supportedLocale}>
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
