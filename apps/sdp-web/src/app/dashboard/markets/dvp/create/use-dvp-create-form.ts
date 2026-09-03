"use client";

/**
 * All of the create form's state, in one place.
 *
 * Split out from the component so the markup reads as layout and this reads as
 * behaviour. The two legs are near-identical in structure but not in origin —
 * the asset comes from Issuance, the cash from a fixed stablecoin list — so
 * they are kept as separate fields rather than an array that pretends they are
 * interchangeable.
 */

import { type SolanaCluster, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { toBaseUnits } from "./dvp-amount";
import type { DvpCreateContext, DvpCreateOption } from "./dvp-create.data";

/** Sentinel for "not one of the listed mints", which opens a paste field. */
export const CUSTOM = "__custom__";

const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];

/** Base58 excludes 0, O, I and l so they cannot be confused when read aloud. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A month out: long enough to fund and settle, well inside the program's cap. */
function defaultExpiry(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Stablecoins deployed on this cluster, for the cash leg.
 *
 * One pass. Filtering and then mapping walks the list twice, and the mint
 * lookup that decides membership is the same lookup that builds the option.
 */
function cashOptionsFor(cluster: SolanaCluster): DvpCreateOption[] {
  const options: DvpCreateOption[] = [];
  for (const token of Object.values(WELL_KNOWN_TOKENS)) {
    if (!token.isUsdStable) {
      continue;
    }
    const mint = (token.mints as Record<string, { address: string; decimals: number }>)[cluster];
    if (!mint) {
      continue;
    }
    options.push({
      mint: mint.address,
      label: token.symbol,
      decimals: mint.decimals,
      // USDC and USDT are legacy SPL Token. Assuming Token-2022 here would have
      // create reject every stablecoin leg.
      tokenProgram: SPL_TOKEN_PROGRAMS[token.tokenProgram],
    });
  }
  return options;
}

export interface DvpCreateForm {
  cashChoice: string;
  cashCustom: string;
  cashOptions: DvpCreateOption[];
  cashSymbol: string;
  cashToken: DvpCreateOption | null;
  counterparty: string;
  counterpartyLooksWrong: boolean;
  error: string | null;
  expiry: string;
  assetChoice: string;
  assetCustom: string;
  assetSymbol: string;
  assetToken: DvpCreateOption | null;
  amountA: string;
  amountB: string;
  baseA: string | null;
  baseB: string | null;
  ready: boolean;
  refString: string;
  sdpSide: "a" | "b";
  submit: (event: React.FormEvent) => Promise<void>;
  submitting: boolean;
  walletId: string;
  setAmountA: (next: string) => void;
  setAmountB: (next: string) => void;
  setAssetChoice: (next: string) => void;
  setAssetCustom: (next: string) => void;
  setCashChoice: (next: string) => void;
  setCashCustom: (next: string) => void;
  setCounterparty: (next: string) => void;
  setExpiry: (next: string) => void;
  setRefString: (next: string) => void;
  setSdpSide: (next: "a" | "b") => void;
  setWalletId: (next: string) => void;
}

export function useDvpCreateForm(cluster: SolanaCluster, context: DvpCreateContext): DvpCreateForm {
  const router = useRouter();
  const cashOptions = useMemo(() => cashOptionsFor(cluster), [cluster]);

  const [walletId, setWalletId] = useState(context.wallets[0]?.id ?? "");
  const [sdpSide, setSdpSide] = useState<"a" | "b">("a");
  const [counterparty, setCounterparty] = useState("");
  const [assetChoice, setAssetChoice] = useState(context.tokens[0]?.mint ?? CUSTOM);
  const [assetCustom, setAssetCustom] = useState("");
  const [cashChoice, setCashChoice] = useState(cashOptions[0]?.mint ?? CUSTOM);
  const [cashCustom, setCashCustom] = useState("");
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  // Passed uncalled: React only uses a lazy initializer's return on the first
  // render, so calling it here would build a Date on every keystroke.
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [refString, setRefString] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assetToken = context.tokens.find((token) => token.mint === assetChoice) ?? null;
  const cashToken = cashOptions.find((token) => token.mint === cashChoice) ?? null;
  const mintA = assetToken?.mint ?? assetCustom.trim();
  const mintB = cashToken?.mint ?? cashCustom.trim();

  const resolvedA = assetToken?.decimals != null ? toBaseUnits(amountA, assetToken.decimals) : null;
  const resolvedB = cashToken?.decimals != null ? toBaseUnits(amountB, cashToken.decimals) : null;
  const baseA = resolvedA ? (resolvedA.ok ? resolvedA.baseUnits : null) : amountA.trim() || null;
  const baseB = resolvedB ? (resolvedB.ok ? resolvedB.baseUnits : null) : amountB.trim() || null;

  const trimmedCounterparty = counterparty.trim();
  // Only once there is enough typed to judge. Complaining at the first
  // character is noise, not help.
  const counterpartyLooksWrong =
    trimmedCounterparty.length > 0 && !BASE58_ADDRESS.test(trimmedCounterparty);

  const ready = Boolean(
    walletId && trimmedCounterparty && !counterpartyLooksWrong && mintA && mintB && baseA && baseB
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!(baseA && baseB)) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/markets/dvp/trades", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // One logical request: a double submit, or a retry after a dropped
          // connection, must not create a second trade at a second address.
          "Idempotency-Key": `dvp-create-${walletId}-${trimmedCounterparty}-${baseA}-${baseB}-${expiry}`,
        },
        body: JSON.stringify({
          sdpWalletId: walletId,
          sdpSide,
          counterparty: trimmedCounterparty,
          mintA,
          mintB,
          // Each listed mint carries its own program. A PASTED address is
          // assumed Token-2022; if it is not, create refuses and names the
          // mismatch rather than publishing an escrow derived under the wrong
          // program, which is the failure this field cannot detect itself.
          tokenProgramA: assetToken?.tokenProgram ?? TOKEN_2022,
          tokenProgramB: cashToken?.tokenProgram ?? TOKEN_2022,
          amountA: baseA,
          amountB: baseB,
          expiryTimestamp: String(Math.floor(new Date(`${expiry}T23:59:59Z`).getTime() / 1000)),
          ...(refString.trim() ? { refString: refString.trim() } : {}),
        }),
      });

      // Status before body. A non-2xx response carries an error envelope, not
      // a trade, and reading it as one would navigate to `undefined`.
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(failure.error?.message ?? `Create failed (${response.status}).`);
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        data?: { trade?: { id?: string } };
      };
      const id = body.data?.trade?.id;
      router.push(
        id ? `${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/${id}` : DASHBOARD_MARKETS_SUBNAV_HREFS.dvp
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return {
    amountA,
    amountB,
    assetChoice,
    assetCustom,
    assetSymbol: assetToken?.label ?? "",
    assetToken,
    baseA,
    baseB,
    cashChoice,
    cashCustom,
    cashOptions,
    cashSymbol: cashToken?.label ?? "",
    cashToken,
    counterparty,
    counterpartyLooksWrong,
    error,
    expiry,
    ready,
    refString,
    sdpSide,
    setAmountA,
    setAmountB,
    setAssetChoice,
    setAssetCustom,
    setCashChoice,
    setCashCustom,
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
