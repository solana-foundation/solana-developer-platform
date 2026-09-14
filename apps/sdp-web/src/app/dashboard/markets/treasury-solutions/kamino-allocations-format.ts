import {
  decimalScale,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
} from "@sdp/solana/amount";
import type { KaminoVaultAllocation, KaminoVaultAllocations } from "./kamino-allocations-schema";

/**
 * Display helpers for the Treasury Solutions "Information" column. Pure and
 * directive-free so the workspace renders and the unit tests read the exact
 * same figures.
 *
 * Like `formatProviderApy`, these deliberately take ONE `Number` on a RATE or
 * percent for `Intl` percent output. They never touch amounts: USD figures go
 * through `formatUsd`, which formats the decimal string exactly.
 */

function formatPercentUnits(pct: string | undefined, locale: string, digits: number): string {
  if (pct === undefined || !isDecimalString(pct)) return "—";
  const value = Number(pct);
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: "percent",
  }).format(value / 100);
}

/** A percent-unit weight ("23.94" = 23.94%) as a locale percent string. */
export function formatAllocationWeight(pct: string | undefined, locale: string): string {
  return formatPercentUnits(pct, locale, 1);
}

/** A decimal-fraction APY ("0.0449" = 4.49%) as a locale percent string. */
export function formatAllocationApy(apy: string | undefined, locale: string): string {
  if (apy === undefined || !isDecimalString(apy)) return "—";
  const rate = Number(apy);
  if (!Number.isFinite(rate)) return "—";
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 1,
    style: "percent",
  }).format(rate);
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

/** Whether the vault read carries anything the disclosure can honestly show. */
export function hasKaminoAllocationContent(allocations: KaminoVaultAllocations): boolean {
  return allocations.allocations.length > 0 || allocations.unallocated !== undefined;
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
