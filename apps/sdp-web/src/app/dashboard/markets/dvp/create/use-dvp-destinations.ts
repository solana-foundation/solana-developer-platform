"use client";

/**
 * Where each party's proceeds go, when that is not the party itself.
 *
 * Its own hook for the same reason each leg has one: this is a self-contained
 * pair of optional fields with a validity rule of their own, and folding them
 * into the form hook made that hook's control flow the thing a reader had to
 * hold in their head to answer any question about it.
 *
 * Values are kept AS TYPED and only trimmed on the way out. Empty is the
 * ordinary trade and means the party's own address, which is what the program
 * records for an omitted destination — so "left blank" and "typed the party's
 * own address" have to stay distinguishable. The idempotency key depends on
 * that distinction: it mirrors the API's fingerprint field for field, and the
 * API treats an absent destination and an explicit one as different requests.
 */

import { useState } from "react";

/** Base58 excludes 0, O, I and l so they cannot be confused when read aloud. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface DvpDestinations {
  /** As typed, so the field renders what was entered. */
  destinationA: string;
  destinationB: string;
  setDestinationA: (next: string) => void;
  setDestinationB: (next: string) => void;
  /** Something is typed and it is not a base58 address. Blank is not wrong. */
  destinationALooksWrong: boolean;
  destinationBLooksWrong: boolean;
  /** Trimmed, for the request. Empty means the party's own address. */
  trimmedDestinationA: string;
  trimmedDestinationB: string;
  /** Whether either named destination is unusable, so submit can be blocked. */
  anyLooksWrong: boolean;
}

/**
 * Judges a destination only once something is typed.
 *
 * Complaining at the first character is noise: these fields are optional, and
 * blank is the default rather than a mistake.
 */
function looksWrong(trimmed: string): boolean {
  return trimmed.length > 0 && !BASE58_ADDRESS.test(trimmed);
}

export function useDvpDestinations(): DvpDestinations {
  const [destinationA, setDestinationA] = useState("");
  const [destinationB, setDestinationB] = useState("");

  const trimmedDestinationA = destinationA.trim();
  const trimmedDestinationB = destinationB.trim();
  const destinationALooksWrong = looksWrong(trimmedDestinationA);
  const destinationBLooksWrong = looksWrong(trimmedDestinationB);

  return {
    destinationA,
    destinationB,
    setDestinationA,
    setDestinationB,
    destinationALooksWrong,
    destinationBLooksWrong,
    trimmedDestinationA,
    trimmedDestinationB,
    anyLooksWrong: destinationALooksWrong || destinationBLooksWrong,
  };
}
