import {
  decimalScale,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
} from "@sdp/solana/amount";
import { BASE58_ADDRESS_PATTERN } from "../base58-address";
import type { KaminoVaultAllocation, KaminoVaultAllocations } from "./kamino-allocations-schema";

/**
 * Display helpers for the Treasury Solutions "Information" column. Pure and
 * directive-free so the workspace renders and the unit tests read the exact
 * same figures.
 *
 * Like `formatProviderApy`, the weight formatter deliberately takes ONE
 * `Number` on a percent for `Intl` percent output; the deployed-weight
 * complement below never routes through a float at all.
 */

/**
 * A percent-unit weight ("23.94" = 23.94%) as a locale percent string. A live
 * weight too small for one decimal would print as "0.0%" and read as nothing,
 * so it is shown as "<0.1%" instead; a weight that IS nothing never reaches
 * here (see `kaminoDisclosureRows`).
 */
export function formatAllocationWeight(pct: string | undefined, locale: string): string {
  if (pct === undefined || !isDecimalString(pct)) return "—";
  const value = Number(pct);
  if (!Number.isFinite(value)) return "—";
  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
    style: "percent",
  });
  if (value > 0 && value < 0.05) return `<${formatter.format(0.001)}`;
  return formatter.format(value / 100);
}

/** Exactly zero, decided on the decimal string: "0", "0.00" and "0.000" all qualify. */
function isZeroWeight(pct: string): boolean {
  if (!isDecimalString(pct)) return false;
  return parseDecimalAmount(pct, decimalScale(pct)) === 0n;
}

/**
 * The disclosure's label for a market. Kamino reports an unnamed market by its
 * address; that is shortened the way SDP shows any address, with the full
 * string kept in the cell's `title`.
 */
export function kaminoMarketLabel(marketName: string): string {
  if (!BASE58_ADDRESS_PATTERN.test(marketName)) return marketName;
  return `${marketName.slice(0, 6)}…${marketName.slice(-4)}`;
}

/**
 * How much of the vault's capital is deployed to lending reserves, as a
 * percent-unit decimal string ("99.94"), computed as the complement of the
 * unallocated share without routing money through a JavaScript float. Undefined
 * when the complement cannot be certified (missing, malformed, or a negative /
 * over-100% share), so the summary stays unavailable rather than wrong.
 */
export function kaminoDeployedWeightPct(unallocatedPct: string | undefined): string | undefined {
  if (unallocatedPct === undefined || !isDecimalString(unallocatedPct)) return undefined;
  const scale = decimalScale(unallocatedPct);
  const hundred = parseDecimalAmount("100", scale);
  const unallocated = parseDecimalAmount(unallocatedPct, scale);
  if (unallocated < 0n || unallocated > hundred) return undefined;
  return formatDecimalAmount(hundred - unallocated, scale);
}

/**
 * Reserve rows for the disclosure, heaviest first: the summary's top
 * allocation is the row a treasury actually asks about first. Rows whose
 * weight cannot be read sort last, preserving the provider's order among
 * themselves.
 */
export function kaminoAllocationsByWeight(
  allocations: readonly KaminoVaultAllocation[]
): KaminoVaultAllocation[] {
  const indexed = allocations.map((allocation, index) => {
    const weight = Number(allocation.actualPct);
    return {
      index,
      weight: Number.isFinite(weight) ? weight : undefined,
    };
  });
  return indexed
    .map(({ index }) => allocations[index])
    .sort((left, right) => {
      const leftWeight = Number(left.actualPct);
      const rightWeight = Number(right.actualPct);
      const leftComparable = Number.isFinite(leftWeight);
      const rightComparable = Number.isFinite(rightWeight);
      if (leftComparable && rightComparable && leftWeight !== rightWeight) {
        return rightWeight - leftWeight;
      }
      if (leftComparable !== rightComparable) return leftComparable ? -1 : 1;
      return 0;
    });
}

export type KaminoDisclosureRow =
  | { kind: "market"; reserve: string; marketName: string; pct: string }
  | { kind: "idle"; pct: string };

/**
 * The rows the disclosure lists: markets holding capital, heaviest first, then
 * the idle share. A weight that is exactly zero says nothing about where the
 * vault's capital is, so it is left out (an unreadable weight stays, as "—").
 */
export function kaminoDisclosureRows(allocations: KaminoVaultAllocations): KaminoDisclosureRow[] {
  const rows: KaminoDisclosureRow[] = kaminoAllocationsByWeight(allocations.allocations)
    .filter((row) => !isZeroWeight(row.actualPct))
    .map((row) => ({
      kind: "market",
      reserve: row.reserve,
      marketName: row.marketName,
      pct: row.actualPct,
    }));
  const idle = allocations.unallocated?.pct;
  if (idle !== undefined && !isZeroWeight(idle)) rows.push({ kind: "idle", pct: idle });
  return rows;
}

/** Whether the vault read carries anything the disclosure can honestly show. */
export function hasKaminoAllocationContent(allocations: KaminoVaultAllocations): boolean {
  return kaminoDisclosureRows(allocations).length > 0;
}

/** Locale timestamp for the provider's `asOf` marker; undefined when unusable. */
export function formatKaminoAsOf(asOf: string | undefined, locale: string): string | undefined {
  if (!asOf) return undefined;
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
