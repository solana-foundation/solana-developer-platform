"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { TransferDirection } from "@/components/transfer-dialog";
import {
  ApiError,
  cancelQueuedWithdrawal,
  createDeposit,
  createWithdrawal,
  getDashboard,
} from "@/lib/api";
import {
  ACTIVE_MOVEMENT_REFRESH_MS,
  applyInFlight,
  applySubmittedTransfers,
  foldSettledTransfers,
  type InFlightTransfer,
  isPendingMovement,
  type MovementPolling,
  partitionSettledTransfersBySnapshot,
  reconcileInFlight,
  reconcileMovementPolling,
  reconcileSubmittedTransfers,
  SETTLEMENT_POLL_TIMEOUT_MS,
  type SubmittedTransfer,
  startMovementPolling,
} from "@/lib/movements";
import type { DashboardData, WithdrawalIntent } from "@/types";

const BACKGROUND_REFRESH_MS = 30_000;
const QUEUED_WITHDRAWAL_REFRESH_MS = 10_000;
const RATE_LIMIT_PAUSE_MS = 10_000;

const TRANSFER_COPY: Record<
  TransferDirection,
  { pending: string; done: string; failed: string }
> = {
  "to-savings": {
    pending: "Moving money to savings",
    done: "Moved to savings",
    failed: "Could not move money to savings",
  },
  "to-checking": {
    pending: "Moving money to checking",
    done: "Moved to checking",
    failed: "Could not move money to checking",
  },
};

function confirmationDescription(
  cluster: DashboardData["wallet"]["cluster"] | undefined,
  state: "Confirmed" | "Confirming"
): string {
  const network =
    cluster === "mainnet-beta"
      ? "Solana mainnet"
      : cluster === "devnet"
        ? "Solana devnet"
        : "Solana";
  return `${state} on ${network}`;
}

function showSettledTransferToasts(
  settled: readonly InFlightTransfer[],
  completedMovementIds: Set<string>,
  movementToastIds: Map<string, ReturnType<typeof toast.loading>>,
  cluster: DashboardData["wallet"]["cluster"] | undefined
) {
  for (const transfer of settled) {
    if (completedMovementIds.has(transfer.movementId)) continue;
    completedMovementIds.add(transfer.movementId);
    const toastId = movementToastIds.get(transfer.movementId);
    toast.success(
      TRANSFER_COPY[
        transfer.direction === "deposit" ? "to-savings" : "to-checking"
      ].done,
      {
        id: toastId,
        description: confirmationDescription(cluster, "Confirmed"),
      }
    );
    movementToastIds.delete(transfer.movementId);
  }
}

export function useDashboardController() {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [movementPolling, setMovementPolling] = useState<MovementPolling>();
  const movementPollingRef = useRef<MovementPolling | undefined>(undefined);
  const requestId = useRef(0);
  const refreshInProgress = useRef(false);
  const [inFlight, setInFlight] = useState<InFlightTransfer[]>([]);
  const [submittedTransfers, setSubmittedTransfers] = useState<
    SubmittedTransfer[]
  >([]);
  const inFlightRef = useRef<InFlightTransfer[]>([]);
  const inFlightBase = useRef<DashboardData>(undefined);
  const movementToastIds = useRef(
    new Map<string, ReturnType<typeof toast.loading>>()
  );
  const completedMovementIds = useRef(new Set<string>());
  const latestData = useRef<DashboardData>(undefined);
  const pausedUntil = useRef(0);
  const wasSettling = useRef(false);

  const updateInFlight = useCallback((next: InFlightTransfer[]) => {
    inFlightRef.current = next;
    setInFlight(next);
  }, []);

  const updateMovementPolling = useCallback((next?: MovementPolling) => {
    movementPollingRef.current = next;
    setMovementPolling(next);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInProgress.current) return;
    refreshInProgress.current = true;
    const id = ++requestId.current;
    try {
      const next = await getDashboard(
        movementPollingRef.current?.movementIds ?? []
      );
      if (id !== requestId.current) return;
      latestData.current = next;
      setData(next);
      setSubmittedTransfers((current) =>
        reconcileSubmittedTransfers(current, next.movements)
      );
      const reconciliation = reconcileMovementPolling(
        movementPollingRef.current,
        next.movements
      );
      updateMovementPolling(reconciliation.polling);
      const current = inFlightRef.current;
      if (current.length) {
        const { failed, remaining, settled } = reconcileInFlight(
          current,
          next.movements
        );
        const balanceReconciliation = inFlightBase.current
          ? partitionSettledTransfersBySnapshot(
              inFlightBase.current,
              next,
              settled
            )
          : { reflected: settled, waiting: [] };
        const now = Date.now();
        const expired = balanceReconciliation.waiting.filter(
          (transfer) => now >= transfer.expiresAt
        );
        const waiting = balanceReconciliation.waiting.filter(
          (transfer) => now < transfer.expiresAt
        );
        const timedOutMovementIds = new Set(reconciliation.timedOutMovementIds);
        const timedOut = remaining.filter((transfer) =>
          timedOutMovementIds.has(transfer.movementId)
        );
        const activeRemaining = remaining.filter(
          (transfer) => !timedOutMovementIds.has(transfer.movementId)
        );
        const keepIds = new Set(
          [...activeRemaining, ...waiting].map(
            (transfer) => transfer.movementId
          )
        );
        const keep = current.filter((transfer) =>
          keepIds.has(transfer.movementId)
        );
        const reflectedOrExpired = [
          ...balanceReconciliation.reflected,
          ...expired,
        ];
        if (reflectedOrExpired.length && keep.length && inFlightBase.current) {
          inFlightBase.current = foldSettledTransfers(
            inFlightBase.current,
            reflectedOrExpired
          );
        }
        showSettledTransferToasts(
          settled,
          completedMovementIds.current,
          movementToastIds.current,
          latestData.current?.wallet.cluster
        );
        if (expired.length) {
          toast.warning("Balances are taking longer to update", {
            id: "balance-sync-timeout",
            description:
              "The transfer is settled. Refresh to check the latest live balances.",
          });
        }
        for (const transfer of failed) {
          const copy =
            TRANSFER_COPY[
              transfer.direction === "deposit" ? "to-savings" : "to-checking"
            ];
          const toastId = movementToastIds.current.get(transfer.movementId);
          toast.error(copy.failed, {
            id: toastId,
            description: "No money was moved.",
          });
          movementToastIds.current.delete(transfer.movementId);
        }
        for (const transfer of timedOut) {
          const toastId = movementToastIds.current.get(transfer.movementId);
          if (toastId !== undefined) toast.dismiss(toastId);
          movementToastIds.current.delete(transfer.movementId);
        }
        updateInFlight(keep);
      }
      if (reconciliation.timedOutMovementIds.length) {
        toast.warning("Settlement is taking longer than expected", {
          id: "settlement-timeout",
          description:
            "Automatic refresh paused for timed-out transfers. Refresh to check again.",
        });
      }
      setError(undefined);
    } catch (caught) {
      if (id !== requestId.current) return;
      if (caught instanceof ApiError && caught.status === 429) {
        pausedUntil.current =
          Date.now() + (caught.retryAfterMs ?? RATE_LIMIT_PAUSE_MS);
        if (latestData.current) return;
      }
      setError(
        caught instanceof Error ? caught.message : "Unable to load the demo"
      );
    } finally {
      refreshInProgress.current = false;
    }
  }, [updateMovementPolling, updateInFlight]);

  const refreshWithProgress = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval =
      movementPolling || inFlight.length
        ? ACTIVE_MOVEMENT_REFRESH_MS
        : data?.withdrawalRequests.length
          ? QUEUED_WITHDRAWAL_REFRESH_MS
          : BACKGROUND_REFRESH_MS;
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        Date.now() >= pausedUntil.current
      ) {
        void refresh();
      }
    }, interval);
    return () => window.clearInterval(timer);
  }, [
    data?.withdrawalRequests.length,
    inFlight.length,
    movementPolling,
    refresh,
  ]);

  useEffect(() => {
    const settling = movementPolling !== undefined || inFlight.length > 0;
    if (wasSettling.current && !settling) {
      const timer = window.setTimeout(() => void refresh(), 3_000);
      wasSettling.current = settling;
      return () => window.clearTimeout(timer);
    }
    wasSettling.current = settling;
  }, [inFlight.length, movementPolling, refresh]);

  const transfer = useCallback(
    async (direction: TransferDirection, input: string | WithdrawalIntent) => {
      const amount = typeof input === "string" ? input : input.amount;
      const copy = TRANSFER_COPY[direction];
      setBusy(true);
      const toastId = toast.loading(copy.pending);
      try {
        const result =
          direction === "to-savings"
            ? { kind: "movement" as const, ...(await createDeposit(amount)) }
            : await createWithdrawal(input as WithdrawalIntent);
        if (result.kind === "queued") {
          toast.success("Withdrawal requested", {
            id: toastId,
            description:
              "Shares are escrowed. Northstar will keep checking for payment or recovery.",
          });
          void refresh();
          return;
        }
        const { movement } = result;
        if (movement.status === "failed") {
          throw new Error(movement.failureReason ?? copy.failed);
        }
        setSubmittedTransfers((current) => [
          { movement, requestedTokenAmount: amount },
          ...current.filter(
            (submitted) => submitted.movement.movementId !== movement.movementId
          ),
        ]);
        if (isPendingMovement(movement)) {
          const polling = startMovementPolling(
            movementPollingRef.current,
            movement.movementId
          );
          const expiresAt =
            polling.expiresAtByMovement[movement.movementId] ??
            Date.now() + SETTLEMENT_POLL_TIMEOUT_MS;
          updateMovementPolling(polling);
          if (!inFlightRef.current.length) {
            inFlightBase.current = latestData.current;
          }
          updateInFlight([
            ...inFlightRef.current,
            {
              movementId: movement.movementId,
              direction: direction === "to-savings" ? "deposit" : "withdrawal",
              amount,
              expiresAt,
            },
          ]);
          movementToastIds.current.set(movement.movementId, toastId);
          toast.info(copy.pending, {
            id: toastId,
            description: confirmationDescription(
              latestData.current?.wallet.cluster,
              "Confirming"
            ),
          });
        } else {
          toast.success(copy.done, {
            id: toastId,
            description: confirmationDescription(
              latestData.current?.wallet.cluster,
              "Confirmed"
            ),
          });
        }
        void refresh();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : copy.failed, {
          id: toastId,
        });
        throw caught;
      } finally {
        setBusy(false);
      }
    },
    [refresh, updateInFlight, updateMovementPolling]
  );

  const cancelWithdrawalRequest = useCallback(
    async (withdrawalRequestId: string) => {
      setBusy(true);
      const toastId = toast.loading("Returning shares");
      try {
        await cancelQueuedWithdrawal(withdrawalRequestId);
        toast.success("Share recovery submitted", {
          id: toastId,
          description: "Northstar will keep checking the final queue outcome.",
        });
        void refresh();
      } catch (caught) {
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Could not return the queued shares",
          { id: toastId }
        );
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const activity = data
    ? applySubmittedTransfers(data, submittedTransfers)
    : data;
  const view =
    activity && inFlight.length && inFlightBase.current
      ? applyInFlight(inFlightBase.current, activity, inFlight)
      : activity;

  const retry = useCallback(() => void refresh(), [refresh]);
  const refreshDashboard = useCallback(
    () => void refreshWithProgress(),
    [refreshWithProgress]
  );
  const deposit = useCallback(
    (amount: string) => transfer("to-savings", amount),
    [transfer]
  );
  const withdraw = useCallback(
    (input: WithdrawalIntent) => transfer("to-checking", input),
    [transfer]
  );

  return {
    busy,
    error: data ? undefined : error,
    loading: !data && !error,
    refreshing,
    view,
    retry,
    refresh: refreshDashboard,
    deposit,
    withdraw,
    cancelQueuedWithdrawal: cancelWithdrawalRequest,
  };
}
