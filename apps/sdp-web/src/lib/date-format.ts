/*
 * Locale-aware date formatting for display, in the viewer's zone (`useTimeZone` or
 * `getRequestTimeZone`), so the server render and hydration agree. Missing or unparseable input
 * is null, so the caller shows its own translated placeholder. Formatters are cached per locale,
 * zone and style.
 */

type DateFormatStyle = "date" | "dateTime";

const STYLE_OPTIONS = {
  date: { dateStyle: "medium" },
  dateTime: { dateStyle: "medium", timeStyle: "short" },
} as const satisfies Record<DateFormatStyle, Intl.DateTimeFormatOptions>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, timeZone: string, style: DateFormatStyle): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${style}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, { ...STYLE_OPTIONS[style], timeZone });
    formatters.set(key, found);
  }
  return found;
}

function format(
  locale: string,
  timeZone: string,
  iso: string | null | undefined,
  style: DateFormatStyle
) {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return formatter(locale, timeZone, style).format(time);
}

/** The day in the viewer's zone, in the locale's medium form ("Nov 4, 2026"). */
export function formatDate(
  locale: string,
  timeZone: string,
  iso: string | null | undefined
): string | null {
  return format(locale, timeZone, iso, "date");
}

/** The day and the minute in the viewer's zone ("Nov 4, 2026, 9:36 AM"). */
export function formatDateTime(
  locale: string,
  timeZone: string,
  iso: string | null | undefined
): string | null {
  return format(locale, timeZone, iso, "dateTime");
}
