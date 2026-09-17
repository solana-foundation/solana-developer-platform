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
  applyInFlight,
  type InFlightTransfer,
  isPendingMovement,
  type MovementPolling,
  reconcileMovementPolling,
  startMovementPolling,
} from "@/lib/movements";
import type { DashboardData } from "@/types";

// SDP records settlement on a once-a-minute reconciliation, and each refresh
// costs three SDP calls plus one RPC read, so poll gently: the in-flight
// projection already shows the balances a pending transfer will produce.
const SETTLING_REFRESH_MS = 8_000;
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
  // Transfers submitted from this tab, plus the balances from just before the
  // first one. The view projects them until SDP reports settlement.
  const [inFlight, setInFlight] = useState<InFlightTransfer[]>([]);
  const inFlightBase = useRef<DashboardData>(undefined);
  const latestData = useRef<DashboardData>(undefined);
  // When SDP rate-limits us, stop polling until the moment it named.
  const pausedUntil = useRef(0);

  const updateMovementPolling = useCallback((next?: MovementPolling) => {
    movementPollingRef.current = next;
    setMovementPolling(next);
  }, []);

  const refresh = useCallback(
    async (background = false) => {
      const id = ++requestId.current;
      if (background) setRefreshing(true);
      try {
        const next = await getDashboard();
        if (id !== requestId.current) return;
        latestData.current = next;
        setData(next);
        const reconciliation = reconcileMovementPolling(
          movementPollingRef.current,
          next.movements
        );
        updateMovementPolling(reconciliation.polling);
        const settled = new Set(
          next.movements
            .filter((movement) => !isPendingMovement(movement))
            .map((movement) => movement.movementId)
        );
        setInFlight((current) =>
          reconciliation.timedOut
            ? []
            : current.filter((transfer) => !settled.has(transfer.movementId))
        );
        if (reconciliation.timedOut) {
          toast.warning("Settlement is taking longer than expected", {
            id: "settlement-timeout",
            description: "Automatic refresh paused. Refresh to check again.",
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
        if (id === requestId.current) setRefreshing(false);
      }
    },
    [updateMovementPolling]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep balances live like a bank app: a quick cadence while a transfer is
  // settling, a slow one otherwise, and nothing while the tab is hidden.
  useEffect(() => {
    const interval = movementPolling
      ? SETTLING_REFRESH_MS
      : BACKGROUND_REFRESH_MS;
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        Date.now() >= pausedUntil.current
      ) {
        void refresh(true);
      }
    }, interval);
    return () => window.clearInterval(timer);
  }, [movementPolling, refresh]);

  // Provider valuations can lag the ledger by a beat. Once the last pending
  // transfer settles, take one more look so savings catches up on its own.
  const wasSettling = useRef(false);
  useEffect(() => {
    const settling = movementPolling !== undefined;
    if (wasSettling.current && !settling) {
      const timer = window.setTimeout(() => void refresh(true), 3_000);
      wasSettling.current = settling;
      return () => window.clearTimeout(timer);
    }
    wasSettling.current = settling;
  }, [movementPolling, refresh]);

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
        updateMovementPolling(
          startMovementPolling(movementPollingRef.current, movement.movementId)
        );
        setInFlight((current) => {
          if (!current.length) inFlightBase.current = latestData.current;
          return [
            ...current,
            {
              movementId: movement.movementId,
              direction: direction === "to-savings" ? "deposit" : "withdrawal",
              amount,
            },
          ];
        });
      }
      toast.success(copy.done, {
        id: toastId,
        description:
          movement.status === "finalized"
            ? undefined
            : "Settling on Solana devnet",
      });
      await refresh(true);
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
                onRefresh={() => void refresh(true)}
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
