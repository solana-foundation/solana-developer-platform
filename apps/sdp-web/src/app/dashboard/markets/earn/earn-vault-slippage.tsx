"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * Slippage-floor machinery shared by the vault DEPOSIT and WITHDRAW modals.
 *
 * Both directions follow the same contract: quote the provider's live rate,
 * derive the floor as `quotedQuantity × (1 − toleranceBps/10⁴)`, and refuse to
 * submit without a quote — arithmetic on the caller's own input is only right
 * while the share rate happens to be 1:1. One copy of that machinery, because
 * two copies of a funds-protection rule is how one drifts (the same reasoning
 * that extracted `earn-idempotency-key-store`).
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
 * quote and the transaction landing. Floored, with a one-atom floor under
 * THAT: rounding up could exceed the quote itself, and a zero floor is no
 * protection at all (the builders refuse it). A dust quote therefore demands
 * its whole quoted quantity back, which is the honest floor for dust.
 */
export function floorForTolerance(
  quotedQuantity: string,
  decimals: number,
  toleranceBps: number
): string {
  const atoms = decimalStringToAtoms(quotedQuantity, decimals);
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

export type VaultQuoteState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "quoted"; preview: T };

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
  fetchRef.current = fetchQuote;

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
              ? { kind: "quoted", preview: result.preview }
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

export interface VaultSlippageSectionProps {
  /** Unique per surface so two modals can never share an input id. */
  idPrefix: string;
  toleranceBps: number | null;
  input: string;
  open: boolean;
  invalid: boolean;
  submitting: boolean;
  /** Direction-specific helper sentence shown under a valid input. */
  help: string;
  onToggle: () => void;
  onChange: (value: string) => void;
}

/** The disclosure hiding the tolerance until someone asks to configure it. */
export function VaultSlippageSection({
  idPrefix,
  toleranceBps,
  input,
  open,
  invalid,
  submitting,
  help,
  onToggle,
  onChange,
}: VaultSlippageSectionProps) {
  const t = useTranslations();
  const locale = useLocale();
  const percent =
    toleranceBps === null
      ? "—"
      : `${(toleranceBps / 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%`;

  return (
    <div className="mt-3">
      <button
        aria-controls={`${idPrefix}-slippage-section`}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-secondary transition-colors hover:text-primary"
        disabled={submitting}
        onClick={onToggle}
        type="button"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
        {t("DashboardEarn.deposit.vaultSlippageToggle", { percent })}
      </button>
      {open ? (
        <div
          className="mt-2 space-y-2 rounded-lg border border-border-default p-3"
          id={`${idPrefix}-slippage-section`}
        >
          <Label htmlFor={`${idPrefix}-slippage`}>
            {t("DashboardEarn.deposit.vaultSlippageLabel")}
          </Label>
          <Input
            aria-invalid={invalid ? true : undefined}
            disabled={submitting}
            id={`${idPrefix}-slippage`}
            inputMode="numeric"
            maxLength={4}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
            value={input}
          />
          {invalid ? (
            <p className="text-xs text-error" role="alert">
              {t("DashboardEarn.deposit.vaultSlippageInvalid", {
                max: MAX_SLIPPAGE_TOLERANCE_BPS,
              })}
            </p>
          ) : (
            <p className="text-xs leading-5 text-tertiary">{help}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
