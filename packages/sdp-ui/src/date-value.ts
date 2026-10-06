import { enUS, fr } from "date-fns/locale";

// The stored values the date fields read and write: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` for a
// field that takes a time. The pickers and the typed date field share these helpers.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * Resolves the app locale to the date-fns locale used by the calendar.
 *
 * @param locale - The active locale code.
 * @returns The matching date-fns locale.
 */
export function pickerLocale(locale: string) {
  return locale === "fr" ? fr : enUS;
}

/**
 * Parses a `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` value into a local Date.
 *
 * @param value - The stored field value.
 * @returns The local date, or undefined when the value is absent or invalid.
 */
export function parseDateValue(value: string | undefined): Date | undefined {
  const match = value?.match(DATE_PATTERN) ?? value?.match(DATE_TIME_PATTERN);
  if (!match) return undefined;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return undefined;
  }
  return date;
}

/**
 * Formats a local Date as a `YYYY-MM-DD` value.
 *
 * @param date - The date to format.
 * @returns The date portion of the field value.
 */
export function formatDateValue(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Extracts the `HH:mm` portion of a datetime value.
 *
 * @param value - The stored field value.
 * @returns The time portion, or an empty string when the value has none.
 */
export function timeValue(value: string): string {
  const match = value.match(DATE_TIME_PATTERN);
  return match ? `${match[4]}:${match[5]}` : "";
}

/**
 * Formats a stored value for display in the trigger.
 *
 * @param value - The stored field value.
 * @param locale - The active locale code.
 * @param includeTime - Whether to include the time portion.
 * @returns The localized label, or null when the value is absent or invalid.
 */
export function displayValue(value: string, locale: string, includeTime: boolean): string | null {
  const date = parseDateValue(value);
  if (!date) return null;

  if (includeTime) {
    const time = timeValue(value);
    if (time) {
      const [hours, minutes] = time.split(":").map(Number);
      date.setHours(hours, minutes);
    }
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    ...(includeTime ? { timeStyle: "short" } : {}),
  }).format(date);
}

/**
 * Formats a stored range for display in the trigger.
 *
 * @param from - The stored range start.
 * @param to - The stored range end.
 * @param locale - The active locale code.
 * @param endPlaceholder - The label shown while the end date is unset.
 * @returns The localized range label, or null when the start is absent or invalid.
 */
export function displayRangeValue(
  from: string,
  to: string,
  locale: string,
  endPlaceholder: string
): string | null {
  const fromLabel = displayValue(from, locale, false);
  if (!fromLabel) return null;
  const toLabel = displayValue(to, locale, false);
  return `${fromLabel} – ${toLabel ?? endPlaceholder}`;
}
