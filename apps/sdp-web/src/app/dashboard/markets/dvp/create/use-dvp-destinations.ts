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
 * the wrong emphasis. Making it an explicit choice states the default and makes
 * the redirect a deliberate act.
 *
 * A destination is named the same three ways a PARTY is — an SDP wallet, a
 * registered counterparty, or a pasted address — because it is the same kind of
 * question and somebody who just answered it upstream should not meet a
 * different control downstream. Reusing `DvpPartySlot` means one resolver
 * (`resolvePartySlotAddress`) decides what an answer means on both.
 *
 * Values are kept AS TYPED and trimmed on the way out. Empty means "pay the
 * party", which is what the program records for an omitted destination, and the
 * idempotency key mirrors the API fingerprint — so "left on the default" and
 * "typed the party's own address" have to stay distinguishable.
 */

import { useState } from "react";

import { BASE58_ADDRESS_PATTERN } from "../../base58-address";
import type { DvpCreateContext } from "./dvp-create.data";
import { type DvpPartySlot, resolvePartySlotAddress } from "./use-dvp-parties";

export type PayoutMode = "party" | "elsewhere";

/** A destination nobody has named yet. Blank, not a guess at the first wallet. */
const EMPTY_SLOT: DvpPartySlot = { mode: "address", address: "" };

export interface DvpPayout {
  mode: PayoutMode;
  setMode: (next: PayoutMode) => void;
  /** Which reference kind names this destination, and its value. */
  slot: DvpPartySlot;
  setSlot: (next: DvpPartySlot) => void;
  /** What the slot resolves to. As typed when the slot is a pasted address. */
  address: string;
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

function usePayout(context: DvpCreateContext): DvpPayout {
  const [mode, setMode] = useState<PayoutMode>("party");
  const [slot, setSlot] = useState<DvpPartySlot>(EMPTY_SLOT);

  // One resolver for parties and payouts alike, so a wallet means the same
  // address in both places and neither can drift.
  const address = resolvePartySlotAddress(slot, context);
  const trimmed = address.trim();
  // Only a PASTED value can be malformed. A wallet or counterparty that does
  // not resolve is unanswered, which is `incomplete`, not wrong.
  const looksWrong =
    mode === "elsewhere" &&
    slot.mode === "address" &&
    trimmed.length > 0 &&
    !BASE58_ADDRESS_PATTERN.test(trimmed);
  const incomplete = mode === "elsewhere" && trimmed.length === 0;

  return {
    mode,
    setMode,
    slot,
    setSlot,
    address,
    looksWrong,
    incomplete,
    // Switching back to the default must not smuggle a chosen address into the
    // request, so this reads the mode rather than only the value.
    resolved: mode === "elsewhere" ? trimmed : "",
  };
}

export function useDvpDestinations(context: DvpCreateContext): DvpDestinations {
  const a = usePayout(context);
  const b = usePayout(context);

  return {
    a,
    b,
    anyLooksWrong: a.looksWrong || b.looksWrong || a.incomplete || b.incomplete,
    anyRedirected: a.resolved.length > 0 || b.resolved.length > 0,
  };
}

export { EMPTY_SLOT as EMPTY_PAYOUT_SLOT };
