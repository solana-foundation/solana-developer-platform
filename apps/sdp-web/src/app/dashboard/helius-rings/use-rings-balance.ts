"use client";

import { useCallback, useEffect, useState } from "react";
import { type RingsWalletSync, syncRingsWallet } from "./helius-rings.data";

export type RingsBalanceState =
  | { name: "loading" }
  | { name: "observed"; sync: RingsWalletSync }
  | { name: "failed"; message: string | null };

/**
 * Syncs a wallet's shielded balance on mount, on every `refreshTick` change,
 * on every `identity` change, and on demand via the returned `refresh`. A null
 * `walletId` suppresses the fetch — pass null while the wallet has no shielded
 * identity yet.
 *
 * `identity` is the wallet's current shielded address. A re-key keeps the
 * wallet's id and rotates that address, so keying the read on both means a
 * re-keyed wallet is re-read for its new identity: the in-flight read for the
 * old one is cancelled — its result can never render — and the old balance
 * leaves the screen while the replacement is read.
 */
export function useRingsBalance(
  walletId: string | null,
  refreshTick?: number,
  identity?: string | null
): { state: RingsBalanceState; refresh: () => void } {
  const [manualTick, setManualTick] = useState(0);
  const [state, setState] = useState<RingsBalanceState>({ name: "loading" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick and manualTick are trigger-only deps — a change re-runs the sync but the values aren't read inside.
  useEffect(() => {
    if (walletId === null) return;
    let cancelled = false;
    setState({ name: "loading" });
    void (async () => {
      try {
        const result = await syncRingsWallet(walletId);
        if (cancelled) return;
        setState(
          result.sync
            ? { name: "observed", sync: result.sync }
            : { name: "failed", message: result.error ?? null }
        );
      } catch {
        if (!cancelled) setState({ name: "failed", message: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletId, identity, refreshTick, manualTick]);

  const refresh = useCallback(() => setManualTick((current) => current + 1), []);
  return { state, refresh };
}
