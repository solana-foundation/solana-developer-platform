"use client";

import type { EarnVaultPosition } from "@sdp/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEarnFundingWallets } from "../earn/deposit/earn-funding-wallets";
import { useEarnVaultPositions } from "../earn/earn-program-data";
import {
  displayedVaultBalance,
  hasUnconfirmedVaultMovement,
  isCommittedVaultMovement,
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
  const [refreshes, setRefreshes] = useState<readonly { movementIds: ReadonlySet<string> }[]>([]);
  const [refreshError, setRefreshError] = useState<Error>();
  const [pairedMovementIds, setPairedMovementIds] = useState<ReadonlySet<string>>(() => new Set());
  const movementWalletIds = useRef(new Map<string, string>());
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
    async (movementIds?: readonly string[]) => {
      const current = ++generation.current;
      // Treasury keeps a bounded activity window. Retired history must not leak
      // back into retries and exceed the API's 100-movement request limit.
      const movements = new Map(activities.map(({ movement }) => [movement.movementId, movement]));
      const request = {
        movementIds: new Set(
          movementIds ??
            activities
              .filter(
                ({ movement }) =>
                  isCommittedVaultMovement(movement) && movement.committedObservedAt !== undefined
              )
              .map(({ movement }) => movement.movementId)
        ),
      };
      const positionsById = new Map(vaults.positions?.map((position) => [position.id, position]));
      setRefreshes((current) => [...current, request]);
      setPairedMovementIds(
        (previous) =>
          new Set([...previous].filter((id) => movements.has(id) && !request.movementIds.has(id)))
      );
      const requestedActivities = activities.filter(({ movement }) =>
        request.movementIds.has(movement.movementId)
      );
      // Capture submission metadata before a full withdrawal removes its position.
      for (const { movement } of requestedActivities) {
        const walletId =
          movement.custodyWalletId ?? positionsById.get(movement.positionId)?.custodyWalletId;
        if (walletId) movementWalletIds.current.set(movement.movementId, walletId);
      }
      try {
        const positionRead = Promise.resolve(
          vaults.refresh(request.movementIds.size > 0 ? [...request.movementIds] : undefined)
        );
        const results = await Promise.allSettled([
          positionRead,
          positionRead.then((read) => {
            if (request.movementIds.size === 0) return funding.refreshBalances();
            if (
              !read ||
              read.minimumSlot === undefined ||
              pendingVaultBalanceReads(requestedActivities, read).length > 0
            ) {
              throw new Error("Vault balance read did not verify the requested movements");
            }
            // A new deposit may first appear in this response, after the request began.
            const returnedPositions = new Map(
              read.positions.map((position) => [position.id, position])
            );
            const walletIds = [...request.movementIds].map((movementId) => {
              const movement = movements.get(movementId);
              const walletId =
                (movement
                  ? returnedPositions.get(movement.positionId)?.custodyWalletId
                  : undefined) ?? movementWalletIds.current.get(movementId);
              if (!walletId) throw new Error("Confirmed movement wallet is not yet available");
              movementWalletIds.current.set(movementId, walletId);
              return walletId;
            });
            return funding.refreshBalances(read.minimumSlot, [...new Set(walletIds)]);
          }),
        ]);
        if (current === generation.current) {
          const failed = results.some((result) => result.status === "rejected");
          setRefreshError(
            failed ? new Error("Treasury balances could not be refreshed") : undefined
          );
          if (!failed)
            setPairedMovementIds((previous) => new Set([...previous, ...request.movementIds]));
        }
      } finally {
        setRefreshes((current) => current.filter((item) => item !== request));
      }
    },
    [activities, vaults.positions, vaults.refresh, funding.refreshBalances]
  );

  useEffect(() => {
    const currentIds = new Set(activities.map(({ movement }) => movement.movementId));
    requested.current = new Set([...requested.current].filter((id) => currentIds.has(id)));
    for (const id of movementWalletIds.current.keys()) {
      if (!currentIds.has(id)) movementWalletIds.current.delete(id);
    }
    const confirmed = activities.filter(
      ({ movement }) =>
        isCommittedVaultMovement(movement) && movement.committedObservedAt !== undefined
    );
    const unrequested = confirmed.filter(
      ({ movement }) => !requested.current.has(movement.movementId)
    );
    if (unrequested.length === 0) return;
    for (const { movement } of unrequested) requested.current.add(movement.movementId);
    void refresh(confirmed.map(({ movement }) => movement.movementId));
  }, [activities, refresh]);

  useEffect(() => {
    if (!refreshError) return;
    const retry = setTimeout(() => void refresh(), 5_000);
    return () => clearTimeout(retry);
  }, [refresh, refreshError]);

  const balanceOf = useCallback(
    (position: EarnVaultPosition): TreasuryPositionBalance => {
      const awaitingPair =
        activities.some(
          ({ movement }) =>
            movement.positionId === position.id &&
            isCommittedVaultMovement(movement) &&
            movement.committedObservedAt !== undefined &&
            !pairedMovementIds.has(movement.movementId)
        ) ||
        refreshes.some((read) =>
          activities.some(
            ({ movement }) =>
              movement.positionId === position.id && read.movementIds.has(movement.movementId)
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
    [activities, pairedMovementIds, submissions, refreshes, vaults.error, vaults.reads]
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
      activities.some(
        ({ movement }) =>
          isCommittedVaultMovement(movement) &&
          movement.committedObservedAt !== undefined &&
          !pairedMovementIds.has(movement.movementId)
      ) ||
      pendingVaultBalanceReads(activities, latestRead).length > 0,
    balanceOf,
    beginSubmission,
    refresh,
  };
}
