"use client";

import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BankSidebar, MobileHeader } from "@/components/bank-sidebar";
import { DashboardSkeleton } from "@/components/dashboard-skeleton";
import { OverviewDashboard } from "@/components/overview-dashboard";
import type { TransferDirection } from "@/components/transfer-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import {
  ApiError,
  createDeposit,
  createWithdrawal,
  getDashboard,
} from "@/lib/api";
import {
  ACTIVE_MOVEMENT_REFRESH_MS,
  applyInFlight,
  foldSettledTransfers,
  type InFlightTransfer,
  isPendingMovement,
  type MovementPolling,
  partitionSettledTransfersBySnapshot,
  reconcileInFlight,
  reconcileMovementPolling,
  SETTLEMENT_POLL_TIMEOUT_MS,
  startMovementPolling,
} from "@/lib/movements";
import type { DashboardData } from "@/types";

// Solana confirmation is the customer-visible finish line. Poll quickly until
// confirmation, then let SDP track protocol finalization in the background.
const BACKGROUND_REFRESH_MS = 30_000;
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

export function App() {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [movementPolling, setMovementPolling] = useState<MovementPolling>();
  const movementPollingRef = useRef<MovementPolling | undefined>(undefined);
  const requestId = useRef(0);
  const refreshInProgress = useRef(false);
  // Transfers submitted from this tab, plus the balances from just before the
  // first one. The view projects them until SDP reports settlement.
  const [inFlight, setInFlight] = useState<InFlightTransfer[]>([]);
  const inFlightRef = useRef<InFlightTransfer[]>([]);
  const inFlightBase = useRef<DashboardData>(undefined);
  const movementToastIds = useRef(
    new Map<string, ReturnType<typeof toast.loading>>()
  );
  const completedMovementIds = useRef(new Set<string>());
  const latestData = useRef<DashboardData>(undefined);

  const updateInFlight = useCallback((next: InFlightTransfer[]) => {
    inFlightRef.current = next;
    setInFlight(next);
  }, []);
  // When SDP rate-limits us, stop polling until the moment it named.
  const pausedUntil = useRef(0);

  const updateMovementPolling = useCallback((next?: MovementPolling) => {
    movementPollingRef.current = next;
    setMovementPolling(next);
  }, []);

  const refresh = useCallback(async () => {
    // Solana/RPC reads can occasionally take longer than the one-second
    // active cadence. Skip that tick instead of fanning out stale reads.
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
        // Overlapping transfers: what just settled becomes part of the
        // base so the ones still pending project from the balances it
        // produced. A failed transfer moved nothing and is simply dropped.
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
        for (const transfer of settled) {
          if (completedMovementIds.current.has(transfer.movementId)) continue;
          completedMovementIds.current.add(transfer.movementId);
          const toastId = movementToastIds.current.get(transfer.movementId);
          toast.success(
            TRANSFER_COPY[
              transfer.direction === "deposit" ? "to-savings" : "to-checking"
            ].done,
            { id: toastId }
          );
          movementToastIds.current.delete(transfer.movementId);
        }
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
          toast.error(copy.failed, { id: toastId });
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

  // Keep balances live like a bank app: a quick cadence while a transfer is
  // settling or confirmed balances are catching up, a slow one otherwise,
  // and nothing while the tab is hidden.
  useEffect(() => {
    const interval =
      movementPolling || inFlight.length
        ? ACTIVE_MOVEMENT_REFRESH_MS
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
  }, [inFlight.length, movementPolling, refresh]);

  // After the last projection hands back to a reflected balance snapshot, take
  // one more look so the normal background view starts from fresh data.
  const wasSettling = useRef(false);
  useEffect(() => {
    const settling = movementPolling !== undefined || inFlight.length > 0;
    if (wasSettling.current && !settling) {
      const timer = window.setTimeout(() => void refresh(), 3_000);
      wasSettling.current = settling;
      return () => window.clearTimeout(timer);
    }
    wasSettling.current = settling;
  }, [inFlight.length, movementPolling, refresh]);

  async function transfer(direction: TransferDirection, amount: string) {
    const copy = TRANSFER_COPY[direction];
    setBusy(true);
    const toastId = toast.loading(copy.pending);
    try {
      const { movement } = await (direction === "to-savings"
        ? createDeposit(amount)
        : createWithdrawal(amount));
      if (movement.status === "failed") {
        throw new Error(movement.failureReason ?? copy.failed);
      }
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
          description:
            latestData.current?.wallet.cluster === "mainnet-beta"
              ? "Confirming on Solana mainnet"
              : latestData.current?.wallet.cluster === "devnet"
                ? "Confirming on Solana devnet"
                : "Confirming on Solana",
        });
      } else {
        toast.success(copy.done, { id: toastId });
      }
      // The projected balances and pending activity are already visible. Let
      // the dialog close now while confirmation refreshes silently.
      void refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : copy.failed, {
        id: toastId,
      });
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  const view =
    data && inFlight.length && inFlightBase.current
      ? applyInFlight(inFlightBase.current, data, inFlight)
      : data;

  return (
    <>
      <div className="min-h-svh bg-app lg:flex lg:h-svh lg:overflow-hidden">
        <BankSidebar />
        <div className="min-w-0 flex-1 lg:p-1">
          <MobileHeader />
          <main className="min-h-[calc(100svh-57px)] bg-background lg:h-full lg:overflow-y-auto lg:rounded-2xl lg:border lg:border-foreground/5">
            {!data && !error ? <DashboardSkeleton /> : null}
            {error && !data ? (
              <SetupError message={error} onRetry={() => void refresh()} />
            ) : null}
            {view ? (
              <OverviewDashboard
                data={view}
                refreshing={refreshing}
                busy={busy}
                onRefresh={() => void refreshWithProgress()}
                onDeposit={(amount) => transfer("to-savings", amount)}
                onWithdraw={(amount) => transfer("to-checking", amount)}
              />
            ) : null}
          </main>
        </div>
      </div>
      <Toaster richColors position="bottom-right" />
    </>
  );
}

function SetupError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-[calc(100svh-57px)] items-center justify-center p-5 lg:min-h-full">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertCircleIcon className="size-5" />
          </span>
          <CardTitle>Finish local setup</CardTitle>
          <CardDescription>
            Northstar could not reach the configured wallet and SDP project.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            {message}
          </p>
          <p className="text-sm text-muted-foreground">
            Check the server environment and SDP endpoint, then retry. The
            README has the local and Vercel runbooks.
          </p>
          <Button type="button" className="w-fit" onClick={onRetry}>
            <RefreshCwIcon data-icon="inline-start" />
            Retry
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
