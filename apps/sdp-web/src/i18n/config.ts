export const supportedLocales = ["en", "es", "fr", "pt", "vi"] as const;

export type AppLocale = (typeof supportedLocales)[number];

export const defaultLocale: AppLocale = "en";
export const localeCookieName = "sdp-locale";

export function isAppLocale(value: string | undefined): value is AppLocale {
  return Boolean(value && supportedLocales.includes(value as AppLocale));
}

/** The cookie that tells the server which zone to render a viewer's dates in. */
export const timeZoneCookieName = "sdp-time-zone";

/** The zone a render falls back to when the request names none it can use. */
export const defaultTimeZone = "UTC";

const TIME_ZONE_NAME = /^[A-Za-z0-9_+\-/]{1,64}$/;

/**
 * Whether a value is a time zone `Intl` can format in. A cookie can carry anything, and a zone
 * `Intl` does not know makes it throw.
 *
 * @param value - The candidate IANA zone name, such as `America/Chicago`.
 * @returns True when `Intl.DateTimeFormat` accepts it.
 */
export function isTimeZone(value: string | undefined): value is string {
  if (value === undefined || !TIME_ZONE_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
