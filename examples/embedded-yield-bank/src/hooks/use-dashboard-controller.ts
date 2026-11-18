"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { TransferDirection } from "@/components/transfer-dialog";
import {
  ApiError,
  cancelQueuedWithdrawal,
  getDashboard,
  resumePendingIntent,
} from "@/lib/api";
import {
  prepareDepositOperation,
  prepareWithdrawalOperation,
  resumePendingOperation,
} from "@/lib/core-api";
import { isOperationActive } from "@/lib/core-operation";
import { ACTIVE_MOVEMENT_REFRESH_MS, isPendingMovement } from "@/lib/movements";
import type { DashboardData, WithdrawalIntent } from "@/types";

const BACKGROUND_REFRESH_MS = 30_000;
const QUEUED_WITHDRAWAL_REFRESH_MS = 10_000;

/** Both new operations and legacy pending history recover without optimistic money values. */
export function useDashboardController() {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef<DashboardData | undefined>(undefined);
  const reading = useRef(false);
  const pausedUntil = useRef(0);

  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const legacyPending =
        latest.current?.movements
          .filter(isPendingMovement)
          .map((movement) => movement.movementId) ?? [];
      const next = await getDashboard(legacyPending);
      latest.current = next;
      setData(next);
      setError(undefined);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        pausedUntil.current = Date.now() + (caught.retryAfterMs ?? 10_000);
        if (latest.current) return;
      }
      setError(
        caught instanceof Error ? caught.message : "Unable to load the demo"
      );
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    async function recover() {
      const outcomes = await Promise.allSettled([
        resumePendingIntent(),
        resumePendingOperation(),
      ]);
      if (
        active &&
        outcomes.some(
          (outcome) => outcome.status === "fulfilled" && outcome.value
        )
      )
        await refresh();
    }
    void recover();
    const timer = window.setInterval(
      () => void recover(),
      BACKGROUND_REFRESH_MS
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const settling =
    data?.operations?.some(isOperationActive) ||
    data?.movements.some(isPendingMovement);
  useEffect(() => {
    const interval = settling
      ? ACTIVE_MOVEMENT_REFRESH_MS
      : data?.withdrawalRequests.length
        ? QUEUED_WITHDRAWAL_REFRESH_MS
        : BACKGROUND_REFRESH_MS;
    const timer = window.setInterval(() => {
      if (!document.hidden && Date.now() >= pausedUntil.current) void refresh();
    }, interval);
    return () => window.clearInterval(timer);
  }, [settling, data?.withdrawalRequests.length, refresh]);

  const transfer = useCallback(
    async (direction: TransferDirection, input: string | WithdrawalIntent) => {
      setBusy(true);
      try {
        if (direction === "to-savings") {
          await prepareDepositOperation(
            typeof input === "string" ? input : input.amount
          );
        } else {
          if (typeof input === "string")
            throw new Error("Withdrawal terms are required");
          await prepareWithdrawalOperation(input);
        }
        toast.info("Ready for review", {
          description:
            "Review the terms in Earn activity, then approve execution.",
        });
        await refresh();
      } catch (caught) {
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Could not prepare this transfer"
        );
        throw caught;
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const cancelWithdrawalRequest = useCallback(
    async (withdrawalRequestId: string) => {
      setBusy(true);
      try {
        // Compatibility for a queue created before its history was mapped to an operation.
        await cancelQueuedWithdrawal(withdrawalRequestId);
        toast.info("Cancellation requested", {
          description:
            "The queue remains visible until its outcome is verified.",
        });
        await refresh();
      } catch (caught) {
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Could not request cancellation"
        );
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const refreshDashboard = useCallback(() => {
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  }, [refresh]);

  return {
    busy,
    error: data ? undefined : error,
    loading: !data && !error,
    refreshing,
    view: data,
    retry: () => void refresh(),
    refresh: refreshDashboard,
    deposit: (amount: string) => transfer("to-savings", amount),
    withdraw: (input: WithdrawalIntent) => transfer("to-checking", input),
    cancelQueuedWithdrawal: cancelWithdrawalRequest,
  };
}
