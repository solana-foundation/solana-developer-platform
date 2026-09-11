"use client";

/**
 * The create form's state.
 *
 * Composed rather than written out: the zod-able fields (the two party slots,
 * terms, payer) live in one `useZodForm`, each leg owns its own mint and
 * amount (`useDvpLeg`), the request owns the fetch (`useDvpCreateSubmit`), and
 * what is left here is the handful of derivations that span them, headed by
 * whether the form can be submitted at all.
 */

import type { SolanaCluster } from "@sdp/types";
import { useMemo } from "react";
import { z } from "zod";
import { useZodForm } from "@/lib/use-zod-form";
import { cashOptionsFor } from "./dvp-cash-options";
import type {
  DvpCreateContext,
  DvpCreateOption,
  DvpCreateWallet,
  DvpWalletBalance,
} from "./dvp-create.data";
import { useDvpCreateSubmit } from "./use-dvp-create-submit";
import { type DvpDestinations, useDvpDestinations } from "./use-dvp-destinations";
import { type DvpLeg, useDvpLeg } from "./use-dvp-leg";
import {
  type DvpPartyRef,
  type DvpPartyResolved,
  type DvpPartyWire,
  deriveDvpParties,
  partySlotSchema,
} from "./use-dvp-parties";

export { CUSTOM } from "./use-dvp-leg";
export {
  type DvpPartySlot,
  type DvpPartyWire,
  partySlotSchema,
} from "./use-dvp-parties";

/** A month out at end of day, local: long enough to fund and settle, well inside the program's cap. */
function defaultExpiry(): string {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}T23:59`;
}

/**
 * The fields the form itself owns.
 *
 * The two party slots validate on their own step via `partiesStepSchema`; the
 * terms and payer gate the last steps. One form so a submit reads one set of
 * values, never a field out of step with the slot that owns it.
 */
const createFormSchema = z.object({
  partyA: partySlotSchema,
  partyB: partySlotSchema,
  /** The expiry as a local wall-clock datetime, "YYYY-MM-DDTHH:mm". */
  expiry: z.string().min(1),
  refString: z.string(),
});

export type DvpCreateFormValues = z.infer<typeof createFormSchema>;

/** The terms and payer the last stages read. */
const termsStepSchema = z.object({
  expiry: z.string().min(1),
  refString: z.string(),
});

export { termsStepSchema };

export interface DvpCreateForm {
  values: DvpCreateFormValues;
  /** The two party slots, also surfaced directly for the step to render. */
  partyA: DvpCreateFormValues["partyA"];
  partyB: DvpCreateFormValues["partyB"];
  asset: DvpLeg;
  /** The asset slot's wallet balance of the asset mint, when it names one. */
  assetBalance: DvpWalletBalance | null;
  cash: DvpLeg;
  /** The cash slot's wallet balance of the cash mint, when it names one. */
  cashBalance: DvpWalletBalance | null;
  cashOptions: DvpCreateOption[];
  error: string | null;
  expiry: string;
  refString: string;
  setExpiry: (next: string) => void;
  setParty: (side: "a" | "b", next: DvpCreateFormValues["partyA"]) => void;
  setRefString: (next: string) => void;
  submit: (event: React.FormEvent) => void;
  submitting: boolean;
  /** Where each side is paid, as a choice per party. */
  destinations: DvpDestinations;
  /** Whether the whole form can be submitted: legs, parties and payouts. */
  ready: boolean;
  /** Whether the two party slots are complete and the addresses differ. */
  partiesReady: boolean;
  /** Both slots resolve to the SAME address: the program refuses one party. */
  sameAddress: boolean;
  /** The parties as the request wants them, or null while incomplete. */
  request: { partyA: DvpPartyRef; partyB: DvpPartyRef } | null;
  /** The parties with their resolved addresses, for the idempotency key. */
  wire: { a: DvpPartyWire; b: DvpPartyWire } | null;
  resolved: { a: DvpPartyResolved; b: DvpPartyResolved };
}

/**
 * Whether the form describes a trade that can be created.
 *
 * Pure and outside the hook: it is a dozen independent conditions, and holding
 * them inline made the hook's control flow mostly this one expression.
 */
function canCreateTrade(input: {
  asset: DvpLeg;
  cash: DvpLeg;
  /** Both party slots filled and the two addresses differ. */
  partiesReady: boolean;
  destinationLooksWrong: boolean;
  /** The expiry datetime; the picker's Clear can empty it on review. */
  expiry: string;
}): boolean {
  const { asset, cash } = input;
  // Never while a leg's scale is still being read. The amount would be encoded
  // by whatever decimals happen to be around, which during a lookup is either
  // the previous mint's or none at all.
  const legsResolved = Boolean(
    !asset.pendingLookup && !cash.pendingLookup && asset.mint && cash.mint
  );
  // No base units means no scale, so there is no quantity to send. Never a
  // rounded fallback.
  const amountsResolved = Boolean(asset.baseUnits && cash.baseUnits);
  // A malformed destination is refused by the API anyway; blocking here saves
  // a round trip that costs a custody-provider call.
  const partiesUsable = Boolean(input.partiesReady && !input.destinationLooksWrong);

  return legsResolved && amountsResolved && partiesUsable && input.expiry.trim().length > 0;
}

/**
 * What a slot's wallet holds of the leg that wallet delivers.
 *
 * A wallet holding none of the mint has NO entry in `balances`. That is a
 * balance of zero, not an unknown — rendering it as unknown would drop the row
 * and the over-balance guard with it, so switching to a wallet that cannot
 * deliver the leg would silently look fine. Zero is only knowable once the
 * wallet and the mint's scale are both settled; before that there is genuinely
 * nothing to claim, and this returns null.
 */
function resolveWalletBalance(
  wallet: DvpCreateWallet | null,
  leg: DvpLeg
): DvpWalletBalance | null {
  const decimals = leg.token?.decimals ?? leg.pasted.mint?.decimals ?? null;
  if (!(wallet && leg.mint) || decimals === null) {
    return null;
  }
  return (
    wallet.balances.find((balance) => balance.mint === leg.mint) ?? {
      mint: leg.mint,
      amount: "0",
      decimals,
      symbol: null,
    }
  );
}

export function useDvpCreateForm(cluster: SolanaCluster, context: DvpCreateContext): DvpCreateForm {
  const cashOptions = useMemo(() => cashOptionsFor(cluster), [cluster]);
  // Both legs start unselected — the trade's whole point is choosing them.
  const asset = useDvpLeg(context.tokens, false);
  const cash = useDvpLeg(cashOptions, false);
  const { error, submit: send, submitting } = useDvpCreateSubmit();

  const { values, setField } = useZodForm(createFormSchema, {
    // Both slots start empty in the first picker mode; neither side has an
    // assumable wallet default.
    partyA: { mode: "wallet", walletId: "" },
    partyB: { mode: "wallet", walletId: "" },
    expiry: defaultExpiry(),
    refString: "",
  });

  const destinations = useDvpDestinations();
  const parties = deriveDvpParties({ partyA: values.partyA, partyB: values.partyB }, context);
  const { expiry, refString } = values;

  const ready = canCreateTrade({
    asset,
    cash,
    partiesReady: parties.ready,
    destinationLooksWrong: destinations.anyLooksWrong,
    expiry,
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // `ready` already implies the parties resolved and the legs carry amounts;
    // re-checking narrows the types without asserting, so a future change to
    // `ready` cannot smuggle a half-filled party set into the request.
    if (!(ready && parties.wire && asset.baseUnits && cash.baseUnits)) {
      return;
    }
    void send({
      amountA: asset.baseUnits,
      amountB: cash.baseUnits,
      expiry,
      mintA: asset.mint,
      mintB: cash.mint,
      parties: parties.wire,
      refString: refString.trim(),
      tokenProgramA: asset.token?.tokenProgram ?? null,
      tokenProgramB: cash.token?.tokenProgram ?? null,
      userASettlementDestination: destinations.a.resolved,
      userBSettlementDestination: destinations.b.resolved,
    });
  }

  // A leg's balance belongs to the wallet that DELIVERS it — the wallet named
  // in that leg's slot. The other slot's wallet is not spent from for this
  // leg, and showing its balance would claim we hold what the other party owes.
  const assetWallet = values.partyA.mode === "wallet" ? parties.resolved.a.wallet : null;
  const cashWallet = values.partyB.mode === "wallet" ? parties.resolved.b.wallet : null;

  return {
    values,
    partyA: values.partyA,
    partyB: values.partyB,
    asset,
    assetBalance: resolveWalletBalance(assetWallet, asset),
    cash,
    cashBalance: resolveWalletBalance(cashWallet, cash),
    cashOptions,
    error,
    expiry,
    setExpiry: (next) => setField("expiry", next),
    setParty: (side, next) => setField(side === "a" ? "partyA" : "partyB", next),
    setRefString: (next) => setField("refString", next),
    submit,
    submitting,
    refString,
    destinations,
    ready,
    partiesReady: parties.ready,
    sameAddress: parties.sameAddress,
    request: parties.request,
    wire: parties.wire,
    resolved: parties.resolved,
  };
}
