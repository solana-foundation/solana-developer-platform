"use client";

import type { EarnVaultPosition } from "@sdp/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEarnFundingWallets } from "../earn/deposit/earn-funding-wallets";
import { useEarnVaultPositions } from "../earn/earn-program-data";
import {
  displayedVaultBalance,
  hasUnconfirmedVaultMovement,
  pendingVaultBalanceReads,
  type VaultActivity,
} from "./treasury-vault-balance";

type SubmissionTarget = Pick<
  EarnVaultPosition,
  "provider" | "providerReference" | "custodyWalletId"
>;
export type TreasuryPositionBalance = ReturnType<typeof displayedVaultBalance>;

/** One coordinator for submission, confirmation, and both sides of a balance refresh. */
export function useTreasuryBalances(activities: readonly VaultActivity[]) {
  const funding = useEarnFundingWallets();
  const vaults = useEarnVaultPositions();
  const [submissions, setSubmissions] = useState<readonly SubmissionTarget[]>([]);
  const [refreshes, setRefreshes] = useState<readonly { movementIds: readonly string[] }[]>([]);
  const [refreshError, setRefreshError] = useState<Error>();
  const generation = useRef(0);
  const requested = useRef(new Set<string>());
  const latestRead = vaults.reads.at(-1);

  const beginSubmission = useCallback((target: SubmissionTarget) => {
    // Each disposer owns only this attempt, including close/reopen while a POST is pending.
    const submission = { ...target };
    setSubmissions((current) => [...current, submission]);
    return () => setSubmissions((current) => current.filter((item) => item !== submission));
  }, []);

  const refresh = useCallback(
    async (movementIds?: readonly string[], custodyWalletIds?: readonly string[]) => {
      const current = ++generation.current;
      const request = { movementIds: movementIds ?? [...requested.current] };
      setRefreshes((current) => [...current, request]);
      try {
        const positionRead = Promise.resolve(
          vaults.refresh(request.movementIds.length > 0 ? request.movementIds : undefined)
        );
        const results = await Promise.allSettled([
          positionRead,
          positionRead.then((read) => funding.refreshBalances(read?.minimumSlot, custodyWalletIds)),
        ]);
        if (current === generation.current)
          setRefreshError(
            results.some((result) => result.status === "rejected")
              ? new Error("Treasury balances could not be refreshed")
              : undefined
          );
      } finally {
        setRefreshes((current) => current.filter((item) => item !== request));
      }
    },
    [vaults.refresh, funding.refreshBalances]
  );

  useEffect(() => {
    const unrequested = pendingVaultBalanceReads(activities, latestRead).filter(
      ({ movement }) => !requested.current.has(movement.movementId)
    );
    if (unrequested.length === 0) return;
    for (const { movement } of unrequested) requested.current.add(movement.movementId);
    const confirmed = activities.filter(
      ({ movement }) => movement.status === "confirmed" || movement.status === "finalized"
    );
    const walletIds = confirmed.map(
      ({ movement }) =>
        vaults.positions?.find(({ id }) => id === movement.positionId)?.custodyWalletId
    );
    void refresh(
      confirmed.map(({ movement }) => movement.movementId),
      walletIds.every((id): id is string => id !== undefined) ? [...new Set(walletIds)] : undefined
    );
  }, [activities, latestRead, refresh, vaults.positions]);

  useEffect(() => {
    if (!refreshError) return;
    const retry = setTimeout(() => void refresh(), 5_000);
    return () => clearTimeout(retry);
  }, [refresh, refreshError]);

  const balanceOf = useCallback(
    (position: EarnVaultPosition): TreasuryPositionBalance => {
      const awaitingPair = refreshes.some((read) =>
        activities.some(
          ({ movement }) =>
            movement.positionId === position.id && read.movementIds.includes(movement.movementId)
        )
      );
      if (
        awaitingPair ||
        submissions.some(
          (submission) =>
            submission.provider === position.provider &&
            submission.providerReference === position.providerReference &&
            submission.custodyWalletId === position.custodyWalletId
        )
      ) {
        return { value: undefined, syncing: true };
      }
      return displayedVaultBalance(vaults.reads, position.id, activities, vaults.error);
    },
    [activities, submissions, refreshes, vaults.error, vaults.reads]
  );

  return {
    positions: vaults.positions,
    positionsError: vaults.error,
    positionsLoading: vaults.isLoading,
    wallets: funding.wallets,
    walletsError: funding.error || refreshError,
    walletsLoading: funding.isLoading,
    balancesRefreshing:
      submissions.length > 0 ||
      hasUnconfirmedVaultMovement(activities) ||
      refreshes.length > 0 ||
      (!refreshError && pendingVaultBalanceReads(activities, latestRead).length > 0),
    balanceOf,
    beginSubmission,
    refresh,
  };
}
