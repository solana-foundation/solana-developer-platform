/*
 * Locale-aware number formatting. Formatters are cached: some figures are re-formatted on every
 * animation frame.
 */

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(locale: string, style: "decimal" | "percent", fractionDigits: number) {
  const key = `${locale}|${style}|${fractionDigits}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.NumberFormat(locale, {
      style,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    formatters.set(key, found);
  }
  return found;
}

/** `value` with exactly `fractionDigits` decimals and the locale's grouping. */
export function formatNumber(locale: string, value: number, fractionDigits = 0): string {
  return formatter(locale, "decimal", fractionDigits).format(value);
}

/** A rate given in percent (4.5 for 4.5%), with exactly `fractionDigits` decimals. */
export function formatPercent(locale: string, percent: number, fractionDigits = 0): string {
  return formatter(locale, "percent", fractionDigits).format(percent / 100);
}
