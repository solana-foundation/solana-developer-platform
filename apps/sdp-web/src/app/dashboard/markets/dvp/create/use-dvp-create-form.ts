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
import type { DvpCreateContext, DvpCreateOption } from "./dvp-create.data";
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
  cash: DvpLeg;
  cashOptions: DvpCreateOption[];
  counterparty: string;
  counterpartyLooksWrong: boolean;
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

  const ready = Boolean(
    walletId &&
      trimmedCounterparty &&
      !counterpartyLooksWrong &&
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

  return {
    asset,
    cash,
    cashOptions,
    counterparty,
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
