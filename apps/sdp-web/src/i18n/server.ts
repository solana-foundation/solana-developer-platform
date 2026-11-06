import { cookies, headers } from "next/headers";
import {
  type AppLocale,
  defaultLocale,
  defaultTimeZone,
  isAppLocale,
  isTimeZone,
  localeCookieName,
  supportedLocales,
  timeZoneCookieName,
} from "@/i18n/config";
import { loadMessages, type MessageKey } from "@/i18n/messages";
import { type TranslationValues, translate } from "@/i18n/translate";

function localeFromAcceptLanguage(value: string | null): AppLocale | undefined {
  if (!value) return undefined;

  for (const languageRange of value.split(",")) {
    const language = languageRange.trim().split(";", 1)[0]?.toLowerCase();
    if (!language) continue;

    const exactMatch = supportedLocales.find((locale) => locale.toLowerCase() === language);
    if (exactMatch) return exactMatch;

    const baseLanguage = language.split("-", 1)[0];
    const baseMatch = supportedLocales.find((locale) => locale.split("-", 1)[0] === baseLanguage);
    if (baseMatch) return baseMatch;
  }
}

export async function getRequestLocale(): Promise<AppLocale> {
  const cookieLocale = (await cookies()).get(localeCookieName)?.value;
  if (isAppLocale(cookieLocale)) return cookieLocale;

  return localeFromAcceptLanguage((await headers()).get("accept-language")) ?? defaultLocale;
}

/**
 * The viewer's time zone, from the cookie the browser stores (`TimeZoneProvider`), or UTC
 * before it has stored one.
 *
 * @returns The IANA zone to format the request's dates in.
 */
export async function getRequestTimeZone(): Promise<string> {
  const cookieTimeZone = (await cookies()).get(timeZoneCookieName)?.value;
  return isTimeZone(cookieTimeZone) ? cookieTimeZone : defaultTimeZone;
}

export async function getI18nRequest() {
  const locale = await getRequestLocale();
  return { locale, messages: await loadMessages(locale) };
}

export async function getTranslations() {
  const { messages } = await getI18nRequest();
  return (key: MessageKey, values?: TranslationValues) => translate(messages, key, values);
}
