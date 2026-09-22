"use client";

import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
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
import { Toaster } from "@/components/ui/sonner";
import { useDashboardController } from "@/hooks/use-dashboard-controller";
import type { DashboardData, WithdrawalIntent } from "@/types";

export function App() {
  const dashboard = useDashboardController();

  return (
    <>
      <BankShell
        loading={dashboard.loading}
        error={dashboard.error}
        view={dashboard.view}
        refreshing={dashboard.refreshing}
        busy={dashboard.busy}
        onRetry={dashboard.retry}
        onRefresh={dashboard.refresh}
        onDeposit={dashboard.deposit}
        onWithdraw={dashboard.withdraw}
        onCancelQueuedWithdrawal={dashboard.cancelQueuedWithdrawal}
      />
      <Toaster richColors position="bottom-right" />
    </>
  );
}

function BankShell({
  loading,
  error,
  view,
  refreshing,
  busy,
  onRetry,
  onRefresh,
  onDeposit,
  onWithdraw,
  onCancelQueuedWithdrawal,
}: {
  loading: boolean;
  error?: string;
  view?: DashboardData;
  refreshing: boolean;
  busy: boolean;
  onRetry: () => void;
  onRefresh: () => void;
  onDeposit: (amount: string) => Promise<void>;
  onWithdraw: (input: WithdrawalIntent) => Promise<void>;
  onCancelQueuedWithdrawal: (withdrawalRequestId: string) => Promise<void>;
}) {
  return (
    <div className="min-h-svh bg-app lg:flex lg:h-svh lg:overflow-hidden">
      <BankSidebar />
      <div className="min-w-0 flex-1 lg:p-1">
        <MobileHeader />
        <main className="min-h-[calc(100svh-57px)] bg-background lg:h-full lg:overflow-y-auto lg:rounded-2xl lg:border lg:border-foreground/5">
          {loading ? <DashboardSkeleton /> : null}
          {error ? <SetupError message={error} onRetry={onRetry} /> : null}
          {view ? (
            <OverviewDashboard
              data={view}
              refreshing={refreshing}
              busy={busy}
              onRefresh={onRefresh}
              onDeposit={onDeposit}
              onWithdraw={onWithdraw}
              onCancelQueuedWithdrawal={onCancelQueuedWithdrawal}
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
