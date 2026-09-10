import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BankSidebar, MobileHeader } from "@/components/bank-sidebar";
import { DashboardSkeleton } from "@/components/dashboard-skeleton";
import { OverviewDashboard } from "@/components/overview-dashboard";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createDeposit, createWithdrawal, getDashboard } from "@/lib/api";
import type { DashboardData } from "@/types";

export function App() {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async (background = false) => {
    const id = ++requestId.current;
    if (background) setRefreshing(true);
    try {
      const next = await getDashboard();
      if (id !== requestId.current) return;
      setData(next);
      setError(undefined);
    } catch (caught) {
      if (id !== requestId.current) return;
      setError(
        caught instanceof Error ? caught.message : "Unable to load the demo"
      );
    } finally {
      if (id === requestId.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      !data?.movements.some(
        (movement) => !["finalized", "failed"].includes(movement.status)
      )
    )
      return;
    const timer = window.setInterval(() => void refresh(true), 4_000);
    return () => window.clearInterval(timer);
  }, [data?.movements, refresh]);

  async function runMovement(
    label: "Deposit" | "Withdrawal",
    action: () => ReturnType<typeof createDeposit>
  ) {
    setBusy(true);
    const toastId = toast.loading(`${label} submitted to devnet`);
    try {
      const result = await action();
      if (result.movement.status === "failed") {
        throw new Error(
          result.movement.failureReason ?? `${label} failed on devnet`
        );
      }
      toast.success(
        result.movement.status === "finalized"
          ? `${label} finalized on devnet`
          : `${label} submitted and still settling`,
        { id: toastId }
      );
      await refresh(true);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : `${label} failed`;
      toast.error(message, { id: toastId });
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  async function handleDeposit(strategyId: string, amount: string) {
    await runMovement("Deposit", () => createDeposit(strategyId, amount));
  }

  async function handleWithdrawal(positionId: string, shares: string) {
    await runMovement("Withdrawal", () => createWithdrawal(positionId, shares));
  }

  return (
    <div className="min-h-svh bg-app lg:flex lg:h-svh lg:overflow-hidden">
      <BankSidebar />
      <div className="min-w-0 flex-1 lg:p-1">
        <MobileHeader />
        <main className="min-h-[calc(100svh-57px)] bg-background lg:h-full lg:overflow-y-auto lg:rounded-2xl lg:border lg:border-foreground/5">
          {!data && !error ? <DashboardSkeleton /> : null}
          {error && !data ? (
            <SetupError message={error} onRetry={() => void refresh()} />
          ) : null}
          {data ? (
            <OverviewDashboard
              data={data}
              refreshing={refreshing}
              busy={busy}
              onRefresh={() => void refresh(true)}
              onDeposit={handleDeposit}
              onWithdraw={handleWithdrawal}
            />
          ) : null}
        </main>
      </div>
    </div>
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
            Northstar could not reach the configured wallet and Embedded Yield
            project.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            {message}
          </p>
          <p className="text-sm text-muted-foreground">
            Add the four values in <code>.env</code>, start the local SDP API,
            then retry. The example README contains the complete runbook.
          </p>
          <Button type="button" className="w-fit" onClick={onRetry}>
            <RefreshCwIcon data-icon="inline-start" />
            Retry connection
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
