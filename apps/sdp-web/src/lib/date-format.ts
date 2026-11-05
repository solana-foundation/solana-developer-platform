/*
 * Locale-aware date formatting for display. Missing or unparseable input is null, so the caller
 * shows its own translated placeholder. Formatters are cached per locale and style.
 */

type DateFormatStyle = "date" | "dateTime";

const STYLE_OPTIONS = {
  date: { dateStyle: "medium" },
  dateTime: { dateStyle: "medium", timeStyle: "short" },
} as const satisfies Record<DateFormatStyle, Intl.DateTimeFormatOptions>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, style: DateFormatStyle): Intl.DateTimeFormat {
  const key = `${locale}|${style}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, STYLE_OPTIONS[style]);
    formatters.set(key, found);
  }
  return found;
}

function format(locale: string, iso: string | null | undefined, style: DateFormatStyle) {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return formatter(locale, style).format(time);
}

/** The day, in the locale's medium form ("Nov 4, 2026"). */
export function formatDate(locale: string, iso: string | null | undefined): string | null {
  return format(locale, iso, "date");
}

/** The day and the minute ("Nov 4, 2026, 9:36 AM"). */
export function formatDateTime(locale: string, iso: string | null | undefined): string | null {
  return format(locale, iso, "dateTime");
}
