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
  token: DvpCreateOption | null;
  /**
   * What was read off a pasted mint, for the field to report. Idle for a leg
   * whose mint came from the list, which needed no lookup.
   */
  pasted: PastedMintState;
  /**
   * Whether the amount is a decimal amount rather than base units. False only
   * while a pasted mint has not resolved, which is the one case where nothing
   * knows the scale.
   */
  decimalsKnown: boolean;
}

export function useDvpLeg(options: DvpCreateOption[]): DvpLeg {
  const [choice, setChoice] = useState(options[0]?.mint ?? CUSTOM);
  const [custom, setCustom] = useState("");
  const [amount, setAmount] = useState("");

  const token = options.find((option) => option.mint === choice) ?? null;

  // Only a pasted leg needs the lookup; a listed token already carries its
  // decimals, so this stays idle on the empty string for one.
  const pasted = usePastedMint(token ? "" : custom);

  // A listed mint carries its decimals. A pasted one is read from the chain
  // (`usePastedMint`), because the alternative is asking a person for base
  // units on the leg carrying the security. Until it resolves the field still
  // takes base units rather than guessing a scale and moving the wrong
  // quantity — the fallback is unchanged, it is just far rarer now.
  const decimals = token?.decimals ?? pasted.mint?.decimals ?? null;
  const resolved = decimals != null ? toBaseUnits(amount, decimals) : null;
  const baseUnits = resolved ? (resolved.ok ? resolved.baseUnits : null) : amount.trim() || null;

  return {
    amount,
    baseUnits,
    choice,
    custom,
    decimalsKnown: decimals != null,
    mint: token?.mint ?? custom.trim(),
    pasted,
    setAmount,
    setChoice,
    setCustom,
    // A pasted mint's own metadata beats the raw address, so a resolved paste
    // reads as its symbol everywhere the summary names the leg.
    symbol: token?.label ?? pasted.mint?.symbol ?? pasted.mint?.name ?? "",
    token,
  };
}
