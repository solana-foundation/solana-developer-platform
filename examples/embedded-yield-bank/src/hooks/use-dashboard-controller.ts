"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { TransferDirection } from "@/components/transfer-dialog";
import { ApiError, getDashboard } from "@/lib/api";
import {
  prepareDepositOperation,
  prepareWithdrawalOperation,
  resumePendingOperation,
} from "@/lib/core-api";
import { isOperationActive } from "@/lib/core-operation";
import type { DashboardData, WithdrawalIntent } from "@/types";

const BACKGROUND_REFRESH_MS = 30_000;
const ACTIVE_OPERATION_REFRESH_MS = 2_000;

/** Durable operations recover without optimistic money values. */
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
      const next = await getDashboard();
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
      try {
        if (await resumePendingOperation()) {
          if (active) await refresh();
        }
      } catch (caught) {
        if (active)
          toast.error(
            caught instanceof Error
              ? caught.message
              : "Pending transfer needs recovery"
          );
      }
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

  const settling = data?.operations.some(isOperationActive);
  useEffect(() => {
    const interval = settling
      ? ACTIVE_OPERATION_REFRESH_MS
      : BACKGROUND_REFRESH_MS;
    const timer = window.setInterval(() => {
      if (!document.hidden && Date.now() >= pausedUntil.current) void refresh();
    }, interval);
    return () => window.clearInterval(timer);
  }, [settling, refresh]);

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
  };
}
