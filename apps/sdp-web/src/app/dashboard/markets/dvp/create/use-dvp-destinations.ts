"use client";

/**
 * Where each side's proceeds are paid.
 *
 * Modelled as an explicit CHOICE per side rather than an optional text box.
 *
 * The default is that a side is paid back at the address it funded from, and a
 * hidden empty input never said so: you opened a disclosure, found two blank
 * fields, and had to infer what leaving them blank meant. Worse, redirecting a
 * payout is precisely the shape a forged trade takes, so burying it was exactly
 * the wrong emphasis. Making it two radio options states the default and makes
 * the redirect a deliberate act.
 *
 * Values are kept AS TYPED and trimmed on the way out. Empty means "pay the
 * party", which is what the program records for an omitted destination, and the
 * idempotency key mirrors the API fingerprint — so "left on the default" and
 * "typed the party's own address" have to stay distinguishable.
 */

import { useState } from "react";

/** Base58 excludes 0, O, I and l so they cannot be confused when read aloud. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type PayoutMode = "party" | "elsewhere";

export interface DvpPayout {
  mode: PayoutMode;
  setMode: (next: PayoutMode) => void;
  /** As typed, so the field renders what was entered. */
  address: string;
  setAddress: (next: string) => void;
  /** Something is typed and it is not a base58 address. Blank is not wrong. */
  looksWrong: boolean;
  /** Chosen "elsewhere" but not yet given a usable address. */
  incomplete: boolean;
  /** Trimmed and only when redirected. Empty means pay the party. */
  resolved: string;
}

export interface DvpDestinations {
  a: DvpPayout;
  b: DvpPayout;
  /** Either side is redirected but unusable, so submit must be blocked. */
  anyLooksWrong: boolean;
  /** Either side pays somewhere other than its own address. */
  anyRedirected: boolean;
}

function usePayout(): DvpPayout {
  const [mode, setMode] = useState<PayoutMode>("party");
  const [address, setAddress] = useState("");

  const trimmed = address.trim();
  const looksWrong = mode === "elsewhere" && trimmed.length > 0 && !BASE58_ADDRESS.test(trimmed);
  const incomplete = mode === "elsewhere" && trimmed.length === 0;

  return {
    mode,
    setMode,
    address,
    setAddress,
    looksWrong,
    incomplete,
    // Switching back to the default must not smuggle a typed address into the
    // request, so this reads the mode rather than only the text.
    resolved: mode === "elsewhere" ? trimmed : "",
  };
}

export function useDvpDestinations(): DvpDestinations {
  const a = usePayout();
  const b = usePayout();

  return {
    a,
    b,
    anyLooksWrong: a.looksWrong || b.looksWrong || a.incomplete || b.incomplete,
    anyRedirected: a.resolved.length > 0 || b.resolved.length > 0,
  };
}
