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
}

export function useDvpLeg(options: DvpCreateOption[]): DvpLeg {
  const [choice, setChoice] = useState(options[0]?.mint ?? CUSTOM);
  const [custom, setCustom] = useState("");
  const [amount, setAmount] = useState("");

  const token = options.find((option) => option.mint === choice) ?? null;

  // A listed mint carries its decimals, so the field takes a human amount and
  // converts. A pasted one does not, so the field takes base units directly
  // rather than guessing a scale and moving the wrong quantity.
  const resolved = token?.decimals != null ? toBaseUnits(amount, token.decimals) : null;
  const baseUnits = resolved ? (resolved.ok ? resolved.baseUnits : null) : amount.trim() || null;

  return {
    amount,
    baseUnits,
    choice,
    custom,
    mint: token?.mint ?? custom.trim(),
    setAmount,
    setChoice,
    setCustom,
    symbol: token?.label ?? "",
    token,
  };
}
