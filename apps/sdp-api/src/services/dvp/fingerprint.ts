/**
 * The fingerprint of a keyed create request.
 *
 * An Idempotency-Key on its own is a claim, not a proof: the same key sent with
 * different terms must not hand back the earlier trade. That is not merely
 * confusing. The stored trade publishes escrow addresses, so a wallet-scoped
 * caller replaying another caller's key would receive escrows outside their
 * own scope.
 *
 * Symmetric — no kind branching. Every field that defines the trade goes in:
 * the payer (as sent), both party slots (reference kind, reference value AND
 * resolved address), the mints, token programs, amounts, timestamps,
 * destinations and refString. `tradeKind`/`sdpSide` are gone because the trade
 * no longer has either.
 *
 * `payerWalletId` is hashed AS SENT (null when defaulted), so a retry of the
 * same payload replays even if the project's settlement wallet was since
 * rotated — the trade it hands back is the one the first request made, which
 * is the idempotency contract.
 *
 * No re-hash migration, no v1 compatibility: a v1-keyed replay now mismatches
 * and 409s, which is correct — the payload shape changed (design decision 3,
 * clean break).
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
 * The three values a party slot contributes to the fingerprint.
 *
 * The reference kind goes in so `{address: X}` and `{walletId}`-resolving-to-X
 * hash differently: the same address via a different registered account is a
 * different request (attribution), and a re-pointed account is a different
 * trade (terms). The resolved address goes in so a re-pointed account is
 * caught even when the reference id is unchanged.
 *
 * @param slot - The party slot as the caller sent it.
 * @param resolved - The slot's resolved address and stored ref.
 * @returns The kind, reference value and resolved address.
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
 *
 * @param params.input - The trade as the caller wants it created.
 * @param params.resolvedA - Side A's resolved address and stored ref.
 * @param params.resolvedB - Side B's resolved address and stored ref.
 * @returns A hex digest to compare a replay against.
 */
export function dvpCreateFingerprint({
  input,
  resolvedA,
  resolvedB,
}: DvpCreateFingerprintInput): string {
  // Listed explicitly rather than derived from object iteration, so reordering
  // the interface can never silently invalidate every stored fingerprint.
  //
  // Held as values and hashed through JSON.stringify rather than joined into
  // one string. Joining needs a separator no field can contain, and the
  // separator this used was a raw NUL byte written literally into the source,
  // which made git treat this file as binary and hid it from every diff. It
  // also could not tell an omitted optional from one sent as "", because both
  // became the same empty slot. Encoding keeps null and "" distinct and quotes
  // the delimiters itself.
  const material = [
    // As sent; null when defaulted, so a retry replays even if the project's
    // settlement wallet was since rotated.
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
    // Where the proceeds go is a term of the trade, not a detail of it. Left
    // out, a replay carrying the same key and the same amounts but a different
    // destination would be handed the earlier trade and its escrow addresses,
    // and the caller would then fund a trade delivering somewhere they did not
    // ask for. Null stands for "omitted", which the program and the row both
    // resolve to the party's own address.
    input.userASettlementDestination,
    input.userBSettlementDestination,
  ];

  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
