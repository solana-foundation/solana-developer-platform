import { cookies, headers } from "next/headers";
import {
  type AppLocale,
  defaultLocale,
  isAppLocale,
  localeCookieName,
  supportedLocales,
} from "@/i18n/config";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";

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

export async function getI18nRequest() {
  const locale = await getRequestLocale();
  return { locale, messages: getMessages(locale) };
}

export async function getTranslations() {
  const { messages } = await getI18nRequest();
  return (key: MessageKey, values?: TranslationValues) => translate(messages, key, values);
}
