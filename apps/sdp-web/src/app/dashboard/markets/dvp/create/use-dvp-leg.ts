"use client";

/**
 * One leg of the trade: which mint, and how much of it.
 *
 * Both legs behave identically once their list of options exists, so they share
 * this rather than the form carrying two near-identical sets of fields and the
 * four derivations that hang off each. What differs is only where the options
 * come from, and that is the caller's problem.
 */

import { useState } from "react";
import { toBaseUnits } from "./dvp-amount";
import type { DvpCreateOption } from "./dvp-create.data";
import { type PastedMintState, usePastedMint } from "./use-pasted-mint";

/** Sentinel for "not one of the listed mints", which opens a paste field. */
export const CUSTOM = "__custom__";

export interface DvpLeg {
  amount: string;
  /**
   * The amount in base units, or null while it does not resolve. Null is the
   * signal that blocks submit; it never falls back to a rounded value.
   */
  baseUnits: string | null;
  choice: string;
  custom: string;
  /** The chosen mint address, whether picked from the list or pasted. */
  mint: string;
  setAmount: (next: string) => void;
  setChoice: (next: string) => void;
  setCustom: (next: string) => void;
  symbol: string;
  /** The token's human name ("USD Coin"), or null when no metadata names it. */
  name: string | null;
  token: DvpCreateOption | null;
  /**
   * What was read off a pasted mint, for the field to report. Idle for a leg
   * whose mint came from the list, which needed no lookup.
   */
  pasted: PastedMintState;
  /**
   * The mint's scale, or null while nothing knows it — an unselected mint, or
   * a pasted one whose lookup has not resolved.
   */
  decimals: number | null;
  /**
   * A lookup is in flight for the address currently typed, so the scale of this
   * leg is not yet known and no reading of the amount is trustworthy.
   *
   * Submit must be blocked on this. Both readings are wrong while it is true:
   * the old metadata scales by the previous mint's decimals, and no metadata
   * falls back to treating a human amount as base units. Either sends a
   * different quantity than the one typed.
   */
  pendingLookup: boolean;
}

/**
 * One leg's mint and amount state.
 *
 * @param options - The listed mints this leg can pick from.
 * @param preselectFirst - Whether the leg starts on the first listed mint or
 *   unselected. With no options either way starts on the paste field, the only
 *   thing left to offer.
 * @returns The leg's state and setters.
 */
export function useDvpLeg(options: DvpCreateOption[], preselectFirst: boolean): DvpLeg {
  const [choice, setChoice] = useState(() => {
    if (options.length === 0) {
      return CUSTOM;
    }
    return preselectFirst ? options[0].mint : "";
  });
  const [custom, setCustom] = useState("");
  const [amount, setAmount] = useState("");

  const token = options.find((option) => option.mint === choice) ?? null;

  // Only a pasted leg needs the lookup; a listed token already carries its
  // decimals, so this stays idle on the empty string for one.
  const pasted = usePastedMint(token ? "" : custom);

  // Only metadata that belongs to the address currently typed. A resolved
  // answer for a PREVIOUS address is not a slightly stale answer, it is a
  // different token, and reading its decimals scales the amount by the wrong
  // power of ten.
  const pastedMatchesInput = pasted.address === custom.trim();
  const pastedMint = pastedMatchesInput ? pasted.mint : null;
  const pendingLookup = token === null && (pasted.loading || !pastedMatchesInput);

  // A listed mint carries its decimals. A pasted one is read from the chain by
  // `usePastedMint`.
  //
  // There is no base-unit fallback any more. It read a typed amount as raw base
  // units whenever the scale was unknown, and "unknown" covers a lookup that
  // FAILED — a network error, a body that would not parse — not only a mint
  // with no metadata. Those are different things and it could not tell them
  // apart, so typing 1000 meaning a thousand tokens sent 0.001 of one whenever
  // the request happened to fail. Under-sending is not the safe direction, it
  // is a different wrong number.
  //
  // Without a scale the amount has no meaning, so this leg has no base units
  // and submit is blocked rather than a quantity guessed.
  const decimals = token?.decimals ?? pastedMint?.decimals ?? null;
  const resolved = decimals != null ? toBaseUnits(amount, decimals) : null;
  const baseUnits = resolved?.ok ? resolved.baseUnits : null;

  return {
    amount,
    baseUnits,
    choice,
    custom,
    decimals,
    pendingLookup,
    mint: token?.mint ?? custom.trim(),
    pasted,
    setAmount,
    setChoice,
    setCustom,
    // A pasted mint's own metadata beats the raw address, so a resolved paste
    // reads as its symbol everywhere the summary names the leg.
    symbol: token?.label ?? pastedMint?.symbol ?? pastedMint?.name ?? "",
    name: token?.name ?? pastedMint?.name ?? null,
    token,
  };
}
