"use client";

import { useRouter } from "next/navigation";
import { type AppLocale, isAppLocale, localeCookieName } from "@/i18n/config";
import { useLocale } from "@/i18n/provider";

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
