"use client";

/**
 * Who the two parties to a trade are.
 *
 * Two symmetric slots, each filled by exactly one of three references: one of
 * the org's custody wallets, a registered counterparty crypto-wallet account,
 * or a pasted address. Only the reference type differs between the slots —
 * the wire union is the same shape for both, and which side funds which leg is
 * fixed (party A delivers the asset leg, party B the cash leg).
 *
 * Pure derivation over the form's values: the slots are zod fields in the
 * form's single `useZodForm`, and everything a slot means — its resolved
 * address, its display name, whether the two parties differ — is a function
 * of the values and the offering lists.
 */

import { z } from "zod";
import type { DvpCreateCounterpartyAccount, DvpCreateWallet } from "./dvp-create.data";

/** Base58 excludes 0, O, I and l so they cannot be confused when read aloud. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * One party slot: exactly one reference variant, chosen and filled.
 *
 * The discriminant is the reference kind; the variant's own field must be
 * non-empty (or, for a pasted address, a valid base58 address) for the slot
 * to be usable.
 */
const partySlotSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("wallet"),
    walletId: z.string().min(1),
  }),
  z.object({
    mode: z.literal("counterparty"),
    counterpartyAccountId: z.string().min(1),
  }),
  z.object({
    mode: z.literal("address"),
    address: z.string().regex(BASE58_ADDRESS),
  }),
]);

export type DvpPartySlot = z.infer<typeof partySlotSchema>;
export type DvpPartySlotMode = DvpPartySlot["mode"];

export { partySlotSchema };

/** The two slots together, as the parties step validates them. */
export const partiesStepSchema = z.object({
  partyA: partySlotSchema,
  partyB: partySlotSchema,
});

/** One party on the wire: the exact union the create endpoint takes. */
export type DvpPartyRef =
  | { walletId: string }
  | { counterpartyAccountId: string }
  | { address: string };

/**
 * One party, with what the wire takes alongside what the idempotency key
 * needs: the key hashes the party's ADDRESS and which reference kind named it
 * (the fingerprint-v2 recipe), and a wallet or counterparty id only resolves
 * to its address through the offering lists.
 */
export interface DvpPartyWire {
  ref: DvpPartyRef;
  address: string;
}

/** The party as the request wants it, from an already-valid slot. */
export function partyRefFor(slot: DvpPartySlot): DvpPartyRef {
  switch (slot.mode) {
    case "wallet":
      return { walletId: slot.walletId };
    case "counterparty":
      return { counterpartyAccountId: slot.counterpartyAccountId };
    case "address":
      return { address: slot.address };
  }
}

/**
 * How the slot resolves against the offering lists, for rendering and the
 * same-address guard.
 */
export interface DvpPartyResolved {
  /** Wallet label, counterparty name, or null for a pasted address. */
  label: string | null;
  /** The party's address, or null while the slot does not resolve one. */
  address: string | null;
  /** The wallet the slot names, when it names one of the org's custody wallets. */
  wallet: DvpCreateWallet | null;
}

export interface DvpPartiesContext {
  wallets: DvpCreateWallet[];
  counterpartyAccounts: DvpCreateCounterpartyAccount[];
}

export interface DvpParties {
  /** Both slots resolve and the two addresses differ. */
  ready: boolean;
  /** Both slots resolve to the SAME address: the program refuses one party. */
  sameAddress: boolean;
  /** The parties as the request wants them, or null while incomplete. */
  request: { partyA: DvpPartyRef; partyB: DvpPartyRef } | null;
  /** The parties with their resolved addresses, for the idempotency key. */
  wire: { a: DvpPartyWire; b: DvpPartyWire } | null;
  resolved: { a: DvpPartyResolved; b: DvpPartyResolved };
}

/** The display name and address a filled slot resolves to. */
function resolveSlot(slot: DvpPartySlot, context: DvpPartiesContext): DvpPartyResolved {
  if (slot.mode === "wallet") {
    const wallet = context.wallets.find((candidate) => candidate.id === slot.walletId) ?? null;
    return {
      label: wallet?.label ?? null,
      address: wallet?.address ?? null,
      wallet,
    };
  }
  if (slot.mode === "counterparty") {
    const account = context.counterpartyAccounts.find(
      (candidate) => candidate.counterpartyAccountId === slot.counterpartyAccountId
    );
    return {
      label: account?.name ?? null,
      address: account?.address ?? null,
      wallet: null,
    };
  }
  const trimmed = slot.address.trim();
  return { label: null, address: trimmed.length > 0 ? trimmed : null, wallet: null };
}

/**
 * Everything that follows from the two slot values.
 *
 * Pure so the form hook can derive it during render: `ready` is the parties
 * step's gate, `request` is what submit sends, and `sameAddress` is the one
 * client-side refusal (the program refuses a trade with one party on both
 * sides, and catching it here saves a round trip that costs a provider call).
 */
export function deriveDvpParties(
  values: { partyA: DvpPartySlot; partyB: DvpPartySlot },
  context: DvpPartiesContext
): DvpParties {
  const resolved = {
    a: resolveSlot(values.partyA, context),
    b: resolveSlot(values.partyB, context),
  };
  const addressA = resolved.a.address;
  const addressB = resolved.b.address;
  const bothFilled =
    partySlotSchema.safeParse(values.partyA).success &&
    partySlotSchema.safeParse(values.partyB).success;

  // A trade needs two parties; the program refuses one address on both sides,
  // and catching it here saves a round trip that costs a provider call.
  const sameAddress = addressA !== null && addressB !== null && addressA === addressB;
  const ready = bothFilled && addressA !== null && addressB !== null && !sameAddress;

  const wire =
    addressA === null || addressB === null
      ? null
      : {
          a: { ref: partyRefFor(values.partyA), address: addressA },
          b: { ref: partyRefFor(values.partyB), address: addressB },
        };

  return {
    ready,
    sameAddress,
    request: ready
      ? { partyA: partyRefFor(values.partyA), partyB: partyRefFor(values.partyB) }
      : null,
    wire: ready ? wire : null,
    resolved,
  };
}
