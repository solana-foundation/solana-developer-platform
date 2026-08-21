/**
 * Presentation helpers for the Helius Rings workspace.
 *
 * Timestamps are formatted with the locale the i18n provider resolved rather
 * than the runtime's default, so a server render and its hydration agree.
 * Mirrors `formatWhen` in the private-channels events list.
 */

export function formatWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatTimeOfDay(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(locale, { timeStyle: "medium" });
}
