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
import type { DvpCreateContext, DvpCreateOption, DvpWalletBalance } from "./dvp-create.data";
import { useDvpCreateSubmit } from "./use-dvp-create-submit";
import { type DvpLeg, useDvpLeg } from "./use-dvp-leg";

export { CUSTOM } from "./use-dvp-leg";

/** Base58 excludes 0, O, I and l so they cannot be confused when read aloud. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A month out: long enough to fund and settle, well inside the program's cap. */
function defaultExpiry(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface DvpCreateForm {
  asset: DvpLeg;
  /** The wallet's balance of the asset mint, when SDP delivers that leg. */
  assetBalance: DvpWalletBalance | null;
  cash: DvpLeg;
  /** The wallet's balance of the cash mint, when SDP delivers that leg. */
  cashBalance: DvpWalletBalance | null;
  cashOptions: DvpCreateOption[];
  counterparty: string;
  counterpartyLooksWrong: boolean;
  /** The counterparty is the very wallet funding your leg — one party, two sides. */
  counterpartyIsOwnLegWallet: boolean;
  error: string | null;
  expiry: string;
  ready: boolean;
  refString: string;
  sdpSide: "a" | "b";
  setCounterparty: (next: string) => void;
  setExpiry: (next: string) => void;
  setRefString: (next: string) => void;
  setSdpSide: (next: "a" | "b") => void;
  setWalletId: (next: string) => void;
  submit: (event: React.FormEvent) => void;
  submitting: boolean;
  walletId: string;
}

export function useDvpCreateForm(cluster: SolanaCluster, context: DvpCreateContext): DvpCreateForm {
  const cashOptions = useMemo(() => cashOptionsFor(cluster), [cluster]);
  const asset = useDvpLeg(context.tokens);
  const cash = useDvpLeg(cashOptions);
  const { error, submit: send, submitting } = useDvpCreateSubmit();

  const [walletId, setWalletId] = useState(context.wallets[0]?.id ?? "");
  const [sdpSide, setSdpSide] = useState<"a" | "b">("a");
  const [counterparty, setCounterparty] = useState("");
  // Passed uncalled: React only uses a lazy initializer's return on the first
  // render, so calling it here would build a Date on every keystroke.
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [refString, setRefString] = useState("");

  const trimmedCounterparty = counterparty.trim();
  // Only once there is enough typed to judge. Complaining at the first
  // character is noise, not help.
  const counterpartyLooksWrong =
    trimmedCounterparty.length > 0 && !BASE58_ADDRESS.test(trimmedCounterparty);

  /**
   * The counterparty is the wallet funding your own leg.
   *
   * A trade needs two parties; this is one party on both sides of it, and the
   * program refuses it outright. The API refuses it too — `userA and userB must
   * differ` — but only after resolving the custody signer, so the round trip
   * spends a provider call to return a sentence about `userA` to somebody who
   * has never seen that word. Naming it here, against the address the wallet
   * picker is already showing, costs nothing and says what is wrong.
   *
   * Deliberately only THIS wallet. Trading between two wallets you own is a
   * real trade with two distinct parties, and blocking it would be wrong.
   */
  const counterpartyIsOwnLegWallet =
    trimmedCounterparty.length > 0 &&
    trimmedCounterparty === context.wallets.find((candidate) => candidate.id === walletId)?.address;

  const ready = Boolean(
    // Never while a leg's scale is still being read. The amount would be
    // encoded by whatever decimals happen to be around, which during a lookup
    // is either the previous mint's or none at all.
    !asset.pendingLookup &&
      !cash.pendingLookup &&
      walletId &&
      trimmedCounterparty &&
      !counterpartyLooksWrong &&
      !counterpartyIsOwnLegWallet &&
      asset.mint &&
      cash.mint &&
      asset.baseUnits &&
      cash.baseUnits
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!(ready && asset.baseUnits && cash.baseUnits)) {
      return;
    }
    void send({
      amountA: asset.baseUnits,
      amountB: cash.baseUnits,
      counterparty: trimmedCounterparty,
      expiry,
      mintA: asset.mint,
      mintB: cash.mint,
      refString: refString.trim(),
      sdpSide,
      tokenProgramA: asset.token?.tokenProgram ?? null,
      tokenProgramB: cash.token?.tokenProgram ?? null,
      walletId,
    });
  }

  // The balance belongs to the leg SDP actually delivers — that is the only one
  // spent from this wallet. Showing it on the counterparty's leg would claim we
  // hold what they owe.
  const selectedWallet = context.wallets.find((wallet) => wallet.id === walletId) ?? null;
  const sdpLeg = sdpSide === "a" ? asset : cash;
  const sdpDecimals = sdpLeg.token?.decimals ?? sdpLeg.pasted.mint?.decimals ?? null;
  // A wallet holding none of the mint has NO entry in `balances`. That is a
  // balance of zero, not an unknown — and rendering it as unknown would drop the
  // row and the over-balance guard with it, so switching to a wallet that cannot
  // deliver the leg would silently look fine. Zero is only knowable once the
  // wallet and the mint's scale are both settled; before that there is genuinely
  // nothing to claim.
  const sdpBalance =
    selectedWallet && sdpLeg.mint && sdpDecimals !== null
      ? (selectedWallet.balances.find((balance) => balance.mint === sdpLeg.mint) ?? {
          mint: sdpLeg.mint,
          amount: "0",
          decimals: sdpDecimals,
          symbol: null,
        })
      : null;

  return {
    asset,
    assetBalance: sdpSide === "a" ? sdpBalance : null,
    cash,
    cashBalance: sdpSide === "b" ? sdpBalance : null,
    cashOptions,
    counterparty,
    counterpartyIsOwnLegWallet,
    counterpartyLooksWrong,
    error,
    expiry,
    ready,
    refString,
    sdpSide,
    setCounterparty,
    setExpiry,
    setRefString,
    setSdpSide,
    setWalletId,
    submit,
    submitting,
    walletId,
  };
}
