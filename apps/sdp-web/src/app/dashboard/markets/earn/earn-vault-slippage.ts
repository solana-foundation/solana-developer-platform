"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Slippage-floor machinery shared by the vault DEPOSIT and WITHDRAW modals.
 *
 * Both directions follow the same contract: quote the provider's live rate,
 * derive the floor as `quotedQuantity × (1 − toleranceBps/10⁴)`, and refuse to
 * submit without a quote — arithmetic on the caller's own input is only right
 * while the share rate happens to be 1:1. One copy of that machinery, because
 * two copies of a funds-protection rule is how one drifts (the same reasoning
 * that extracted `earn-idempotency-key-store`). Helpers only — the disclosure
 * COMPONENT lives in `earn-vault-slippage-section.tsx`, because a module that
 * exports both components and helpers breaks Fast Refresh's state preservation.
 */

function atomsToDecimalString(atoms: bigint, decimals: number): string {
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
 * atom would demand MORE than the vault expects to return — an order that can
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

/** True when the quote expects ZERO atoms out — nothing any floor could protect. */
export function isZeroQuote(quotedQuantity: string, decimals: number): boolean {
  return decimalStringToAtoms(quotedQuantity, decimals) === 0n;
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

export type VaultQuoteState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "quoted"; key: string; preview: T };

const QUOTE_DEBOUNCE_MS = 400;

/**
 * The live quote a floor is derived from. Debounced behind typing, aborted on
 * change and unmount, and re-fetched when `refreshKey` bumps — a blown floor
 * retries against a FRESH rate, never the one that just refused.
 *
 * `key` is the serialized quote input; `null` means "nothing to quote" (no
 * floor policy, or the input is not valid yet) and resolves to `idle` without
 * a request. Every failure is `unavailable`, and unavailable DISABLES the
 * action: a floor must come from a quote or not exist. The fetcher is read
 * through a ref so a re-render never re-fires the request.
 */
export function useDebouncedVaultQuote<T>(
  key: string | null,
  fetchQuote: (
    signal: AbortSignal
  ) => Promise<{ kind: "quoted"; preview: T } | { kind: "unavailable" }>,
  refreshKey: number
): VaultQuoteState<T> {
  const [state, setState] = useState<VaultQuoteState<T>>({ kind: "idle" });
  const fetchRef = useRef(fetchQuote);
  // The latest-fetcher write lives in an effect, never in render: React can
  // replay or discard render work, and a mutation there leaks from UI that
  // never commits.
  useEffect(() => {
    fetchRef.current = fetchQuote;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is deliberately unused in the body — bumping it re-runs the quote after a blown floor.
  useEffect(() => {
    if (key === null) {
      setState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      fetchRef.current(controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          setState(
            result.kind === "quoted"
              ? { kind: "quoted", key, preview: result.preview }
              : { kind: "unavailable" }
          );
        },
        () => {
          if (!controller.signal.aborted) setState({ kind: "unavailable" });
        }
      );
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, refreshKey]);

  return state;
}

/**
 * A quote is only usable against the EXACT input it priced. The effect that
 * re-fetches it runs AFTER render, so between edits the retained state still
 * holds the previous input's quote — pairing that floor with the new input
 * would execute a larger request with less protection than the selected
 * tolerance, or refuse a smaller one needlessly. A mismatched quote renders as
 * loading, which is what it is about to become.
 */
export function quoteForKey<T>(quote: VaultQuoteState<T>, key: string | null): VaultQuoteState<T> {
  if (quote.kind !== "quoted") return quote;
  return key !== null && quote.key === key ? quote : { kind: "loading" };
}
