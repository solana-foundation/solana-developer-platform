"use client";

/**
 * Slippage-floor helpers for the vault deposit flow, in their own module so
 * the modal file exports only components — Fast Refresh can then preserve
 * component state instead of full-reloading — and so the WITHDRAW flow can
 * share one copy of a funds-protection rule when it lands. Two copies of this
 * arithmetic is how one drifts.
 */

/** Render `atoms` at `decimals` scale as a canonical decimal string. */
export function atomsToDecimalString(atoms: bigint, decimals: number): string {
  if (decimals === 0) return atoms.toString();
  const padded = atoms.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Inverse of `atomsToDecimalString` for a CANONICAL value at ≤ `decimals` scale. */
function decimalStringToAtoms(canonical: string, decimals: number): bigint {
  const [whole, fraction = ""] = canonical.split(".");
  return BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
}

/** Whole basis points a slippage tolerance may take; 10% is already an outlier. */
export const MAX_SLIPPAGE_TOLERANCE_BPS = 1000;

/** Whole basis points in 1..1000, or `null` for anything else. */
export function parseSlippageToleranceBps(value: string): number | null {
  if (!/^\d{1,4}$/.test(value.trim())) return null;
  const bps = Number(value.trim());
  return bps >= 1 && bps <= MAX_SLIPPAGE_TOLERANCE_BPS ? bps : null;
}

/** True when the quote expects ZERO atoms out — nothing to protect, or deposit. */
export function isZeroQuote(quotedQuantity: string, decimals: number): boolean {
  return decimalStringToAtoms(quotedQuantity, decimals) === 0n;
}

/**
 * The floor a tolerance implies over a LIVE quote:
 * `quotedQuantity × (1 − bps/10⁴)`, floored to the quoted mint's own scale so
 * the builder is never handed sub-atomic precision it would rightly refuse.
 *
 * The quote is the vault's own accounting for the exact request, so the
 * tolerance covers only what it honestly can — the rate moving between the
 * quote and the transaction landing. A POSITIVE dust quote whose floor rounds
 * to zero demands its whole quoted quantity back instead: a zero floor is no
 * protection at all (the builders refuse it), so one atom is the honest floor
 * for dust. A ZERO quote answers `null`, never a floor: there is no
 * satisfiable protection at or below zero expected output, and clamping to one
 * atom would demand MORE than the vault expects to mint — an order that can
 * only ever be refused, however often it is re-quoted. Callers block the
 * submission instead.
 */
export function floorForTolerance(
  quotedQuantity: string,
  decimals: number,
  toleranceBps: number
): string | null {
  const atoms = decimalStringToAtoms(quotedQuantity, decimals);
  if (atoms === 0n) return null;
  const floor = (atoms * BigInt(10_000 - toleranceBps)) / 10_000n;
  return atomsToDecimalString(floor > 0n ? floor : 1n, decimals);
}

/**
 * The API names a blown floor with `error.details.reason` precisely so these
 * surfaces can answer with their own copy and reopen the slippage control,
 * instead of relaying a simulation log. Anything unrecognized stays a plain
 * error.
 */
export function isSlippageExceededRefusal(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return false;
  return (details as { reason?: unknown }).reason === "slippage_exceeded";
}
