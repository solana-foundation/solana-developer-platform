"use client";

/**
 * Who the two parties to a trade are.
 *
 * Two shapes, and which one is chosen changes what the rest of the form means.
 *
 * `principal` is the original: one of your custody wallets delivers a leg and
 * the other side is any address. `agent` is the execution-desk shape — you set
 * the terms and two other parties do the swaps, so your wallet signs and pays
 * but delivers nothing.
 *
 * Its own hook for the same reason the destinations have one: this is a
 * self-contained cluster of state with its own validity rules, and folding it
 * into the form hook made that hook's control flow the thing you had to hold in
 * your head to answer any question about it.
 */

import { useState } from "react";
import type { DvpCreateWallet } from "./dvp-create.data";

/** Base58 excludes 0, O, I and l so they cannot be confused when read aloud. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type DvpTradeKind = "principal" | "agent";

/** The resolved parties, in the form the request wants them. */
export type DvpPartiesRequest =
  | { tradeKind: "principal"; sdpSide: "a" | "b"; counterparty: string }
  | { tradeKind: "agent"; partyA: string; partyB: string };

export interface DvpParties {
  tradeKind: DvpTradeKind;
  setTradeKind: (next: DvpTradeKind) => void;

  /** Principal only: which leg your wallet delivers. */
  sdpSide: "a" | "b";
  setSdpSide: (next: "a" | "b") => void;

  /** Principal only: the other side. As typed. */
  counterparty: string;
  setCounterparty: (next: string) => void;
  counterpartyLooksWrong: boolean;
  /** The counterparty is the very wallet funding your leg: one party, two sides. */
  counterpartyIsOwnLegWallet: boolean;

  /** Agent only: the two parties, neither of them you. As typed. */
  partyA: string;
  setPartyA: (next: string) => void;
  partyB: string;
  setPartyB: (next: string) => void;
  partyALooksWrong: boolean;
  partyBLooksWrong: boolean;
  /** A trade needs two parties; the program refuses one address on both sides. */
  partiesAreSame: boolean;

  /** Whether the parties are complete and usable, whichever shape is chosen. */
  ready: boolean;
  /** The parties as the request wants them, or null while incomplete. */
  request: DvpPartiesRequest | null;
}

/** Judged only once something is typed. Blank is not yet wrong. */
function looksWrong(trimmed: string): boolean {
  return trimmed.length > 0 && !BASE58_ADDRESS.test(trimmed);
}

export function useDvpParties(wallets: DvpCreateWallet[], walletId: string): DvpParties {
  const [tradeKind, setTradeKind] = useState<DvpTradeKind>("principal");
  const [sdpSide, setSdpSide] = useState<"a" | "b">("a");
  const [counterparty, setCounterparty] = useState("");
  const [partyA, setPartyA] = useState("");
  const [partyB, setPartyB] = useState("");

  const trimmedCounterparty = counterparty.trim();
  const trimmedA = partyA.trim();
  const trimmedB = partyB.trim();

  const counterpartyLooksWrong = looksWrong(trimmedCounterparty);
  const partyALooksWrong = looksWrong(trimmedA);
  const partyBLooksWrong = looksWrong(trimmedB);

  /**
   * The counterparty is the wallet funding your own leg.
   *
   * A trade needs two parties; this is one party on both sides of it, and the
   * program refuses it outright. The API refuses it too, but only after
   * resolving the custody signer, so the round trip spends a provider call to
   * return a sentence about `userA` to somebody who has never seen that word.
   *
   * Deliberately only THIS wallet. Trading between two wallets you own is a
   * real trade with two distinct parties.
   */
  const counterpartyIsOwnLegWallet =
    trimmedCounterparty.length > 0 &&
    trimmedCounterparty === wallets.find((candidate) => candidate.id === walletId)?.address;

  // Same rule for the agent shape, where neither address is yours.
  const partiesAreSame = trimmedA.length > 0 && trimmedA === trimmedB;

  const principalReady = Boolean(
    trimmedCounterparty && !counterpartyLooksWrong && !counterpartyIsOwnLegWallet
  );
  const agentReady = Boolean(
    trimmedA && trimmedB && !partyALooksWrong && !partyBLooksWrong && !partiesAreSame
  );
  const ready = tradeKind === "agent" ? agentReady : principalReady;

  const request: DvpPartiesRequest | null = !ready
    ? null
    : tradeKind === "agent"
      ? { tradeKind: "agent", partyA: trimmedA, partyB: trimmedB }
      : { tradeKind: "principal", sdpSide, counterparty: trimmedCounterparty };

  return {
    tradeKind,
    setTradeKind,
    sdpSide,
    setSdpSide,
    counterparty,
    setCounterparty,
    counterpartyLooksWrong,
    counterpartyIsOwnLegWallet,
    partyA,
    setPartyA,
    partyB,
    setPartyB,
    partyALooksWrong,
    partyBLooksWrong,
    partiesAreSame,
    ready,
    request,
  };
}
