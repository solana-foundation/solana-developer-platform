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

/** One tick's read of a single filed action: the reply, or the read error. */
type PollOutcome = { movementId: string; next: EarnProviderAction | null; cause?: unknown };

async function readProviderAction(
  movementId: string,
  action: EarnProviderAction
): Promise<PollOutcome> {
  try {
    return { movementId, next: await fetchEarnProviderAction(action.actionId) };
  } catch (caught) {
    return { movementId, next: null, cause: caught };
  }
}

/**
 * One tick's replies, split so the batch applies in a single state update —
 * applying the first reply on its own would restart the polling effect and
 * strand the slower replies behind its retired `active` flag.
 */
function splitPollResults(results: PollOutcome[]): {
  updates: Record<string, EarnProviderAction>;
  concluded: Array<[string, EarnProviderAction]>;
  readError: unknown;
} {
  const updates: Record<string, EarnProviderAction> = {};
  const concluded: Array<[string, EarnProviderAction]> = [];
  let readError: unknown = null;
  for (const result of results) {
    if (result.next === null) readError ??= result.cause;
    else {
      updates[result.movementId] = result.next;
      if (isTerminalEarnProviderActionStatus(result.next.status))
        concluded.push([result.movementId, result.next]);
    }
  }
  return { updates, concluded, readError };
}

/**
 * Retires the idempotency key of every attempt this batch saw conclude —
 * the next confirmed submit must be free to do new work, not replay a dead
 * one. Returns the first failed action, if any, for the failure surface.
 */
function retireConcludedCancellationKeys(
  concluded: Array<[string, EarnProviderAction]>,
  projectId: string
): EarnProviderAction | null {
  let failed: EarnProviderAction | null = null;
  for (const [movementId, next] of concluded) {
    const fingerprint = JSON.stringify([projectId, movementId]);
    const { key } = cancellationKeys.claim(fingerprint);
    cancellationKeys.release(fingerprint, key);
    if (next.status === "failed") failed ??= next;
  }
  return failed;
}

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
      // Every reply of one tick applies together, in a single state update:
      // applying the first reply on its own would restart this effect and
      // strand the slower replies behind its retired `active` flag, hiding a
      // completed or failed result and keeping its retry button disabled.
      void Promise.all(
        pending.map(([movementId, action]) => readProviderAction(movementId, action))
      )
        .then((results) => {
          if (!active) return;
          const { updates, concluded, readError } = splitPollResults(results);
          if (Object.keys(updates).length > 0)
            setActions((current) => ({ ...current, ...updates }));
          const failed = retireConcludedCancellationKeys(concluded, projectId);
          if (failed !== null) setFailure(failed.error ?? t("DashboardEarn.providerAction.error"));
          if (concluded.length > 0) {
            refresh();
            onChanged?.();
          }
          if (readError !== null)
            setFailure(
              readError instanceof Error
                ? readError.message
                : t("DashboardEarn.providerAction.error")
            );
        })
        .finally(() => {
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
