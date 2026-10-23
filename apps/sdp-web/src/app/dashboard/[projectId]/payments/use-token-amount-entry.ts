"use client";

import { compareDecimalAmounts, decimalScale, isDecimalString } from "@sdp/solana/amount";
import type { TokenAmountQuote, TokenMovementBasis } from "@sdp/types/token-movements";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { isAddress } from "@solana/kit";
import { useState } from "react";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";
import {
  displayAmountSchema,
  type TokenAmountFields,
} from "@/app/dashboard/[projectId]/payments/token-amount-fields";
import {
  type AmountEntryUnit,
  fetchTokenAmountQuote,
  fetchTokenAmountTerms,
  isQuoteCurrent,
  quotedTokenAmount,
  type TokenAmountTerms,
  tokenAmountQuoteRequest,
} from "@/app/dashboard/[projectId]/payments/token-amount-quote.data";
import { useTranslations } from "@/i18n/provider";
import { useDebounce } from "@/lib/use-debounce";

/** As the ramp estimate waits for typing to stop. */
const QUOTE_DEBOUNCE_MS = 300;

/** The earliest a quote is read again after it expires, so a past expiry never loops. */
const MIN_QUOTE_REFRESH_MS = 1_000;

/** The longest timer delay a browser keeps; a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface UseTokenAmountEntryArgs {
  /** The selected token's mint, or null before one is chosen. Native SOL has no terms. */
  mint: string | null;
  /** The side of the movement the amount fixes: a send fixes its debit, a request its credit. */
  basis: TokenMovementBasis;
  /** The form's amount fields: what the user typed, and in which unit. */
  fields: TokenAmountFields;
  /** Sets the form's amount fields, as `useZodForm`'s `setFields` does. */
  setFields: (patch: Partial<TokenAmountFields>) => void;
}

export interface TokenAmountEntry {
  /** The mint's terms, once read. Null for SOL, before a token, or when the read failed. */
  terms: TokenAmountTerms | null;
  /** True when the mint has a display rule, so the user may type what wallets show. */
  displayEntryAvailable: boolean;
  /** What the amount input holds: the form's unit, or token units for a mint with no display rule. */
  unit: AmountEntryUnit;
  setUnit: (unit: AmountEntryUnit) => void;
  /**
   * The movement's amount in token units: what the user typed, or the
   * token amount the display input's quote fixes ("" until it is priced).
   */
  tokenAmount: string;
  /** The quote for the current input; null when nothing needs one or it is not priced yet. */
  quote: TokenAmountQuote | null;
  quoteError: string | null;
  /** True while a quote for the current input is waited for or read. */
  quoteInFlight: boolean;
  /** Whether `tokenAmount` may be submitted at `now`: a display amount needs an unexpired quote. */
  canSubmitAt: (now: number) => boolean;
  /** Prices the current input again, as after an expired quote. */
  refreshQuote: () => void;
}

/**
 * What the entry prices, if anything: a valid display amount always (it has
 * no token amount until priced); a token amount only when the mint charges a
 * transfer fee, so the user sees the fee and the other side first.
 */
function quoteValue(
  unit: AmountEntryUnit,
  fields: TokenAmountFields,
  terms: TokenAmountTerms | null
): string | null {
  switch (unit) {
    case "display": {
      const display = displayAmountSchema.safeParse(fields.displayAmount);
      return display.success ? display.data : null;
    }
    case "token": {
      const input = fields.amount.trim();
      return isDecimalString(input) &&
        compareDecimalAmounts(input, "0") > 0 &&
        terms !== null &&
        terms.transferFee !== null &&
        decimalScale(input) <= terms.decimals
        ? input
        : null;
    }
    default: {
      const unreachable: never = unit;
      throw new Error(`Unknown amount entry unit: ${String(unreachable)}`);
    }
  }
}

/**
 * An amount input that knows the token's terms (ADR 0012). For a scaled or
 * interest-bearing mint the user may type what wallets show; the quote route
 * converts it, and the token amount it returns is what gets sent. For a mint
 * with a transfer fee, a token amount is priced too, to show the fee and the
 * other side of the movement. SOL and classic mints behave as before. What
 * the user typed lives in the caller's form (`tokenAmountFieldsSchema`).
 */
export function useTokenAmountEntry({
  mint,
  basis,
  fields,
  setFields,
}: UseTokenAmountEntryArgs): TokenAmountEntry {
  const t = useTranslations();
  const termsMint = mint !== null && mint !== SOL_MINT && isAddress(mint) ? mint : null;

  // Terms change only by an issuer's action; one read per mint serves the session.
  const { data: termsData } = useSWR(
    termsMint === null ? null : paymentsQueryKeys.tokenTerms({ mint: termsMint }),
    ([, wanted]: readonly [string, string]) => fetchTokenAmountTerms(wanted, t),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      shouldRetryOnError: false,
    }
  );
  const terms = termsMint === null || termsData === undefined ? null : termsData;
  const displayEntryAvailable = terms !== null && terms.display.rule !== "plain";

  // Another token starts over in token units: a display amount means nothing for it.
  const [entryMint, setEntryMint] = useState(mint);
  if (entryMint !== mint) {
    setEntryMint(mint);
    setFields({ amountUnit: "token", displayAmount: "" });
  }
  const unit: AmountEntryUnit = displayEntryAvailable ? fields.amountUnit : "token";

  const value = quoteValue(unit, fields, terms);
  const debouncedValue = useDebounce(value, QUOTE_DEBOUNCE_MS);
  const debouncing = value !== debouncedValue;

  const {
    data: quoteData,
    error: quoteFailure,
    isValidating,
    mutate,
  } = useSWR(
    termsMint !== null && value !== null && !debouncing
      ? paymentsQueryKeys.tokenAmountQuote({ mint: termsMint, unit, value, basis })
      : null,
    ([, wanted, wantedUnit, wantedValue, wantedBasis]: readonly [
      string,
      string,
      AmountEntryUnit,
      string,
      TokenMovementBasis,
    ]) =>
      fetchTokenAmountQuote(
        wanted,
        tokenAmountQuoteRequest(wantedUnit, wantedValue, wantedBasis),
        t
      ),
    {
      keepPreviousData: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      // A quote is priced again when it expires, so the amount on screen stays one that may be sent.
      refreshInterval: (data) =>
        data === undefined
          ? 0
          : Math.min(
              Math.max(Date.parse(data.expiresAt) - Date.now(), MIN_QUOTE_REFRESH_MS),
              MAX_TIMER_DELAY_MS
            ),
    }
  );
  const quote = value === null || debouncing || quoteData === undefined ? null : quoteData;
  const quoteInFlight = value !== null && (debouncing || isValidating);

  let tokenAmount: string;
  if (unit === "token") {
    tokenAmount = fields.amount;
  } else {
    tokenAmount = quote === null ? "" : quotedTokenAmount(quote);
  }

  return {
    terms,
    displayEntryAvailable,
    unit,
    setUnit: (next) => setFields({ amountUnit: next }),
    tokenAmount,
    quote,
    quoteError:
      value !== null && !debouncing && quoteFailure instanceof Error ? quoteFailure.message : null,
    quoteInFlight,
    canSubmitAt: (now) =>
      !quoteInFlight && (unit === "token" || (quote !== null && isQuoteCurrent(quote, now))),
    refreshQuote: () => {
      void mutate();
    },
  };
}
