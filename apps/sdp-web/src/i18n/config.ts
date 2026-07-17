export const supportedLocales = ["en", "kk", "ru"] as const;

export type AppLocale = (typeof supportedLocales)[number];

export const defaultLocale: AppLocale = "en";
export const localeCookieName = "sdp-locale";

export function isAppLocale(value: string | undefined): value is AppLocale {
  return Boolean(value && supportedLocales.includes(value as AppLocale));
}
