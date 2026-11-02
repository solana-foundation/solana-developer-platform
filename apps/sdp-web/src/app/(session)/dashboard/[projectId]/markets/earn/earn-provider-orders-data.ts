"use client";

import type { EarnVaultWithdrawal } from "@sdp/types/earn";
import {
  type EarnProviderAction,
  isTerminalEarnProviderActionStatus,
} from "@sdp/types/earn-provider-orders";
import { earnCanCancelProviderOrder } from "@sdp/types/provider-access";
import { useEffect, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";
import { useProjectId } from "@/lib/use-dashboard-project";
import { useEarnVaultWithdrawals } from "./earn-program-data";
import { createEarnProviderAction, fetchEarnProviderAction } from "./earn-provider-actions";

const cancellationKeys = createIdempotencyKeyStore("sdp:earn:provider-order-cancellation:v1");

/**
 * Owns the behavior behind the provider-orders card: which withdrawals offer
 * a standard cancellation, the cancellation request under its idempotency
 * key, and polling every filed action to a terminal status. The card only
 * renders what this returns.
 */
export function useEarnProviderOrders(onChanged?: () => void) {
  const t = useTranslations(),
    projectId = useProjectId();
  const { withdrawals, error, refresh } = useEarnVaultWithdrawals();
  const [selected, setSelected] = useState<EarnVaultWithdrawal | null>(null);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, EarnProviderAction>>({});
  const orders = (withdrawals ?? []).filter(
    (row) => earnCanCancelProviderOrder(row.provider) && row.redemptionMode === "standard"
  );
  useEffect(() => {
    const pending = Object.entries(actions).filter(
      ([, action]) => !isTerminalEarnProviderActionStatus(action.status)
    );
    if (pending.length === 0) return;
    let active = true;
    let inFlight = false;
    const poll = () => {
      // One read at a time: a tick landing mid-flight is skipped, and the
      // interval keeps firing whatever each attempt observed — repeated
      // identical read errors must not idle polling until an unrelated
      // render restarts it.
      if (inFlight) return;
      inFlight = true;
      void Promise.all(
        pending.map(async ([movementId, action]) => {
          try {
            const next = await fetchEarnProviderAction(action.actionId);
            if (!active) return;
            setActions((current) => ({ ...current, [movementId]: next }));
            if (isTerminalEarnProviderActionStatus(next.status)) {
              // The attempt under this key concluded, so polling retires the
              // key the moment it first sees the outcome — the next confirmed
              // submit must be free to do new work, not replay a dead one.
              const fingerprint = JSON.stringify([projectId, movementId]);
              const { key } = cancellationKeys.claim(fingerprint);
              cancellationKeys.release(fingerprint, key);
              if (next.status === "failed")
                setFailure(next.error ?? t("DashboardEarn.providerAction.error"));
              refresh();
              onChanged?.();
            }
          } catch (cause) {
            if (active)
              setFailure(
                cause instanceof Error ? cause.message : t("DashboardEarn.providerAction.error")
              );
          }
        })
      ).finally(() => {
        inFlight = false;
      });
    };
    const timer = setInterval(poll, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [actions, onChanged, projectId, refresh, t]);

  async function cancel() {
    if (!selected || busy) return;
    const fingerprint = JSON.stringify([projectId, selected.movementId]);
    const { key, persisted } = cancellationKeys.claim(fingerprint);
    if (!persisted) {
      setFailure(t("DashboardEarn.intentStorageUnavailable"));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const action = await createEarnProviderAction(
        "cancellations",
        { movementId: selected.movementId },
        key
      );
      setActions((current) => ({ ...current, [selected.movementId]: action }));
      if (action.status === "failed") {
        cancellationKeys.release(fingerprint, key);
        setFailure(action.error);
      }
      setSelected(null);
      refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : t("DashboardEarn.providerAction.error"));
    } finally {
      setBusy(false);
    }
  }
  return { orders, actions, error, failure, busy, selected, setSelected, setFailure, cancel };
}
