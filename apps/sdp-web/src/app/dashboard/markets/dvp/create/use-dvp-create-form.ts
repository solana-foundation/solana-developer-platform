"use client";

/**
 * The create form's state.
 *
 * Composed rather than written out: each leg owns its own mint and amount
 * (`useDvpLeg`), the request owns the fetch (`useDvpCreateSubmit`), and what is
 * left here is the handful of fields that belong to neither plus the one rule
 * that spans them both, which is whether the form can be submitted at all.
 */

import type { SolanaCluster } from "@sdp/types";
import { useMemo, useState } from "react";
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
import { type DvpParties, useDvpParties } from "./use-dvp-parties";

export { CUSTOM } from "./use-dvp-leg";

/** A month out: long enough to fund and settle, well inside the program's cap. */
function defaultExpiry(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Everything the form owns directly, before the destinations are mixed in. */
interface DvpCreateFormFields {
  asset: DvpLeg;
  /** The wallet's balance of the asset mint, when SDP delivers that leg. */
  assetBalance: DvpWalletBalance | null;
  cash: DvpLeg;
  /** The wallet's balance of the cash mint, when SDP delivers that leg. */
  cashBalance: DvpWalletBalance | null;
  cashOptions: DvpCreateOption[];
  error: string | null;
  expiry: string;
  ready: boolean;
  refString: string;
  setExpiry: (next: string) => void;
  setRefString: (next: string) => void;
  setWalletId: (next: string) => void;
  submit: (event: React.FormEvent) => void;
  submitting: boolean;
  walletId: string;
}

/**
 * The whole form: the fields above plus the optional settlement destinations,
 * which own their own state in `useDvpDestinations`.
 */
export interface DvpCreateForm extends DvpCreateFormFields, Omit<DvpParties, "ready" | "request"> {
  /** Where each side is paid, as a choice per party. */
  destinations: DvpDestinations;
  /** Whether the parties step is complete on its own. */
  partiesReady: boolean;
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
  walletId: string;
  /** Whichever party shape was chosen, complete and usable. */
  partiesReady: boolean;
  destinationLooksWrong: boolean;
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
  const partiesUsable = Boolean(
    input.walletId && input.partiesReady && !input.destinationLooksWrong
  );

  return legsResolved && amountsResolved && partiesUsable;
}

/**
 * What the selected wallet holds of the leg SDP delivers.
 *
 * A wallet holding none of the mint has NO entry in `balances`. That is a
 * balance of zero, not an unknown — rendering it as unknown would drop the row
 * and the over-balance guard with it, so switching to a wallet that cannot
 * deliver the leg would silently look fine. Zero is only knowable once the
 * wallet and the mint's scale are both settled; before that there is genuinely
 * nothing to claim, and this returns null.
 */
function resolveSdpBalance(wallet: DvpCreateWallet | null, leg: DvpLeg): DvpWalletBalance | null {
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
  const asset = useDvpLeg(context.tokens);
  const cash = useDvpLeg(cashOptions);
  const { error, submit: send, submitting } = useDvpCreateSubmit();

  const [walletId, setWalletId] = useState(context.wallets[0]?.id ?? "");
  // Passed uncalled: React only uses a lazy initializer's return on the first
  // render, so calling it here would build a Date on every keystroke.
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [refString, setRefString] = useState("");
  const destinations = useDvpDestinations();
  const parties = useDvpParties(context.wallets, walletId);

  const ready = canCreateTrade({
    asset,
    cash,
    walletId,
    partiesReady: parties.ready,
    destinationLooksWrong: destinations.anyLooksWrong,
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // `ready` already implies the parties resolved; re-checking narrows the
    // type without asserting, so a future change to `ready` cannot smuggle a
    // half-filled party set into the request.
    if (!(ready && asset.baseUnits && cash.baseUnits && parties.request)) {
      return;
    }
    void send({
      amountA: asset.baseUnits,
      amountB: cash.baseUnits,
      expiry,
      mintA: asset.mint,
      mintB: cash.mint,
      refString: refString.trim(),
      parties: parties.request,
      tokenProgramA: asset.token?.tokenProgram ?? null,
      tokenProgramB: cash.token?.tokenProgram ?? null,
      userASettlementDestination: destinations.a.resolved,
      userBSettlementDestination: destinations.b.resolved,
      walletId,
    });
  }

  // The balance belongs to the leg SDP actually delivers — that is the only one
  // spent from this wallet. Showing it on the counterparty's leg would claim we
  // hold what they owe.
  // Only a principal trade spends from this wallet. On an agent trade the
  // wallet pays fees and rent and delivers nothing, so showing a token balance
  // beside a leg would claim we hold what a third party owes.
  const sdpBalance =
    parties.tradeKind === "agent"
      ? null
      : resolveSdpBalance(
          context.wallets.find((wallet) => wallet.id === walletId) ?? null,
          parties.sdpSide === "a" ? asset : cash
        );

  return {
    asset,
    assetBalance: parties.sdpSide === "a" ? sdpBalance : null,
    cash,
    cashBalance: parties.sdpSide === "b" ? sdpBalance : null,
    cashOptions,
    error,
    expiry,
    ready,
    refString,
    setExpiry,
    setRefString,
    setWalletId,
    submit,
    submitting,
    walletId,
    destinations,
    partiesReady: parties.ready,
    // `ready` and `request` are the parties hook's own internal verdict; the
    // form's `ready` spans the legs too and must win.
    ...(({ ready: _ready, request: _request, ...rest }) => rest)(parties),
  };
}
