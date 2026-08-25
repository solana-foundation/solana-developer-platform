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

const UINT_PATTERN = /^\d+$/;
const MAX_TOKEN_DECIMALS = 255;

/**
 * Formats an unsigned base-unit amount without passing the raw integer through
 * `Number`, which would round valid uint64 values. Invalid API input returns
 * `null` so callers can show an explicit unavailable state instead of a
 * plausible but incorrect balance.
 */
export function formatBaseUnitAmount(
  amountRaw: string,
  decimals: number,
  locale: string
): string | null {
  if (
    !UINT_PATTERN.test(amountRaw) ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_TOKEN_DECIMALS
  ) {
    return null;
  }

  const normalized = amountRaw.replace(/^0+(?=\d)/, "");
  const wholeRaw =
    decimals === 0 || normalized.length > decimals
      ? normalized.slice(0, decimals === 0 ? undefined : -decimals)
      : "0";
  const fractionRaw =
    decimals === 0
      ? ""
      : normalized
          .slice(normalized.length > decimals ? -decimals : 0)
          .padStart(decimals, "0")
          .replace(/0+$/, "");

  try {
    const integerFormatter = new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
      useGrouping: true,
    });
    const groupedWhole = integerFormatter.format(BigInt(wholeRaw));
    if (!fractionRaw) return groupedWhole;

    const decimalSeparator = new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value;
    return decimalSeparator ? `${groupedWhole}${decimalSeparator}${fractionRaw}` : null;
  } catch {
    return null;
  }
}
