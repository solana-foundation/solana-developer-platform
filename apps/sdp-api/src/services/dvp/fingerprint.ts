/**
 * The fingerprint of a keyed create request.
 *
 * A key is a claim, not a proof; the hash covers the project scope and every
 * field that defines the trade — both party slots (reference kind, value AND
 * resolved address), mints, token programs, amounts, timestamps, destinations
 * and refString — so a reuse with different terms (or a wallet-scoped caller
 * replaying someone else's key) 409s instead of handing escrows back. The
 * project is material (APE-693): custody, sponsorship and settlement resolve
 * under it, so the same key and terms presented under a sibling project are a
 * different request, never a replay. Hashed AS SENT, so a retry replays even
 * after settlement-wallet rotation.
 *
 * Rows stored before the project entered the hash carry the legacy fingerprint
 * ({@link dvpCreateLegacyFingerprint}); the replay comparison accepts either
 * format, so a retry of a keyed trade created before that change still replays
 * instead of 409ing into a second escrow.
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
 * The terms a keyed create hashes, shared by the current and legacy layouts.
 * Explicit, not derived from object iteration (reordering must never
 * invalidate stored fingerprints); JSON encoding keeps null and "" distinct.
 */
function fingerprintMaterial({
  input,
  resolvedA,
  resolvedB,
}: DvpCreateFingerprintInput): unknown[] {
  return [
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
}

function hashMaterial(material: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/**
 * Hashes the terms a create request asked for, including the project scope.
 */
export function dvpCreateFingerprint({
  input,
  resolvedA,
  resolvedB,
}: DvpCreateFingerprintInput): string {
  return hashMaterial([
    // The project scope comes first: it decides whose custody, sponsorship and
    // settlement context the trade resolves under.
    input.projectId,
    ...fingerprintMaterial({ input, resolvedA, resolvedB }),
  ]);
}

/**
 * The fingerprint format rows stored before APE-693 carry: the same terms with
 * no project scope.
 *
 * The replay comparison accepts this format so pre-existing keyed trades keep
 * their retry path; the idempotency lookup is already project-scoped, so a
 * legacy match still proves the retry arrived under the stored row's own
 * project. FROZEN: changing the material here strands every pre-APE-693 retry.
 */
export function dvpCreateLegacyFingerprint({
  input,
  resolvedA,
  resolvedB,
}: DvpCreateFingerprintInput): string {
  return hashMaterial(fingerprintMaterial({ input, resolvedA, resolvedB }));
}
