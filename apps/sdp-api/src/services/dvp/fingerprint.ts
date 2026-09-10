/**
 * The fingerprint of a keyed create request.
 *
 * A key is a claim, not a proof; the hash covers every field that defines the
 * trade — payer (as sent), both party slots (reference kind, value AND
 * resolved address), mints, token programs, amounts, timestamps, destinations
 * and refString — so a reuse with different terms (or a wallet-scoped caller
 * replaying someone else's key) 409s instead of handing escrows back. Hashed
 * AS SENT, so a retry replays even after settlement-wallet rotation. No v1
 * compatibility: an old-keyed replay now mismatches by design.
 */

import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import type { CreateDvpTradeInput, DvpPartyInput } from "./create";

/** A party slot's contribution to the fingerprint material. */
type PartySlotMaterial = [kind: string, referenceValue: string | null, resolvedAddress: Address];

/** The input a keyed create needs to hash, with resolved addresses alongside. */
export interface DvpCreateFingerprintInput {
  /** The trade as the caller wants it created. */
  input: CreateDvpTradeInput;
  /** Side A's resolved address (and, for a counterparty slot, its stored ref). */
  resolvedA: ResolvedParty;
  /** Side B's resolved address (and, for a counterparty slot, its stored ref). */
  resolvedB: ResolvedParty;
}

/** The result of resolving one party slot: the address, and any stored ref. */
export interface ResolvedParty {
  /** The on-chain address the slot resolves to. */
  address: Address;
  /** The counterparty account id stored for attribution, or null. */
  counterpartyAccountId: string | null;
}

/**
 * A slot's three fingerprint values: reference kind AND value AND resolved
 * address, so the same address via a different reference hashes differently.
 */
function partySlotMaterial(slot: DvpPartyInput, resolved: ResolvedParty): PartySlotMaterial {
  if ("walletId" in slot) {
    return ["wallet", slot.walletId, resolved.address];
  }
  if ("counterpartyAccountId" in slot) {
    return ["counterparty", slot.counterpartyAccountId, resolved.address];
  }
  return ["address", slot.address, resolved.address];
}

/**
 * Hashes the terms a create request asked for.
 */
export function dvpCreateFingerprint({
  input,
  resolvedA,
  resolvedB,
}: DvpCreateFingerprintInput): string {
  // Explicit, not derived from object iteration (reordering must never
  // invalidate stored fingerprints); JSON encoding keeps null and "" distinct.
  const material = [
    // As sent; null when defaulted, so a retry replays across settlement-wallet rotation.
    input.payerWalletId,
    ...partySlotMaterial(input.partyA, resolvedA),
    ...partySlotMaterial(input.partyB, resolvedB),
    input.mintA,
    input.tokenProgramA,
    input.mintB,
    input.tokenProgramB,
    input.amountA.toString(),
    input.amountB.toString(),
    input.expiryTimestamp.toString(),
    input.earliestSettlementTimestamp === null
      ? null
      : input.earliestSettlementTimestamp.toString(),
    input.refString,
    // A destination is a term: a replay with a different one must not hand back
    // the earlier trade's escrows. Null stands for "omitted" (the party's own address).
    input.userASettlementDestination,
    input.userBSettlementDestination,
  ];

  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
