import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  WalletCardsIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatAccountToken,
  formatApy,
  formatDate,
  formatToken,
  shortAddress,
  titleCase,
} from "@/lib/format";
import type { DashboardData, YieldPosition } from "@/types";
import { DepositDialog, WithdrawDialog } from "./money-movement-dialog";

interface OverviewDashboardProps {
  data: DashboardData;
  refreshing: boolean;
  busy: boolean;
  onRefresh: () => void;
  onDeposit: (strategyId: string, amount: string) => Promise<void>;
  onWithdraw: (positionId: string, shares: string) => Promise<void>;
}

export function OverviewDashboard({
  data,
  refreshing,
  busy,
  onRefresh,
  onDeposit,
  onWithdraw,
}: OverviewDashboardProps) {
  const pendingMovement = data.movements.some(
    (movement) =>
      movement.status !== "finalized" && movement.status !== "failed"
  );

  async function copyWalletAddress() {
    try {
      await navigator.clipboard.writeText(data.wallet.address);
      toast.success("Wallet address copied");
    } catch {
      toast.error("Could not copy the wallet address");
    }
  }

  return (
    <div className="flex flex-col gap-7 p-5 sm:p-8 xl:p-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-[28px]">
            Good morning, Alex
          </h1>
          <p className="text-sm text-muted-foreground">
            Here is what is happening with your money today.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-1.5 text-muted-foreground/70 hover:bg-transparent hover:text-muted-foreground"
            aria-label={`Copy wallet address ${data.wallet.address}`}
            title={data.wallet.address}
            onClick={() => void copyWalletAddress()}
          >
            {shortAddress(data.wallet.address)}
            <CopyIcon data-icon="inline-end" />
          </Button>
          <Badge variant="outline" className="status-success">
            <span className="status-dot" />
            Solana devnet
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCwIcon
              className={refreshing ? "animate-spin" : undefined}
              data-icon="inline-start"
            />
            Refresh
          </Button>
        </div>
      </header>

      {pendingMovement ? (
        <div className="flex items-center gap-3 rounded-xl border bg-muted/50 px-4 py-3 text-sm">
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
          <span>
            A devnet movement is settling. Balances will refresh automatically.
          </span>
        </div>
      ) : null}

      <Card className="overflow-hidden border-foreground/10 shadow-[0_1px_2px_rgba(28,28,29,0.04)]">
        <CardHeader className="border-b bg-muted/30">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Total balance</span>
                <Badge variant="secondary">Live</Badge>
              </div>
              <CardTitle className="text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
                {formatAccountToken(
                  data.totals.portfolio,
                  data.totals.tokenSymbol
                )}
              </CardTitle>
              <CardDescription>
                One account token, combining its on-chain balance and live
                Embedded Yield positions.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <DepositDialog
                strategies={data.strategies}
                balances={data.balances}
                feesPaidBy={data.wallet.feesPaidBy}
                busy={busy}
                onSubmit={onDeposit}
              />
              <WithdrawDialog
                positions={data.positions}
                feesPaidBy={data.wallet.feesPaidBy}
                busy={busy}
                onSubmit={onWithdraw}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-0 p-0 sm:grid-cols-3">
          <BalanceMetric
            label="Available"
            value={formatAccountToken(
              data.totals.available,
              data.totals.tokenSymbol
            )}
          />
          <BalanceMetric
            label="In yield"
            value={formatAccountToken(
              data.totals.inYield,
              data.totals.tokenSymbol
            )}
            unavailable={data.totals.unavailableYieldPositions > 0}
          />
          <BalanceMetric
            label="Total earned"
            value={formatAccountToken(
              data.totals.earned,
              data.totals.tokenSymbol,
              { signed: true }
            )}
            positive
          />
        </CardContent>
      </Card>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Your yield</CardTitle>
              <CardDescription>
                Live positions owned by your Northstar wallet.
              </CardDescription>
            </div>
            <Badge variant="secondary">Embedded Yield</Badge>
          </CardHeader>
          <CardContent>
            {data.positions.length ? (
              <div className="flex flex-col gap-3">
                {data.positions.map((position) => (
                  <PositionRow
                    key={position.id}
                    position={position}
                    tokenSymbol={
                      data.balances.find(
                        (balance) => balance.mint === position.tokenMint
                      )?.symbol ?? "tokens"
                    }
                    feesPaidBy={data.wallet.feesPaidBy}
                    busy={busy}
                    onWithdraw={onWithdraw}
                  />
                ))}
              </div>
            ) : (
              <EmptyYield />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Northstar balance</CardTitle>
            <CardDescription>
              Assets read directly from the managed wallet.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {data.balances.map((balance) => (
              <div
                key={balance.mint}
                className="flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    {balance.symbol.slice(0, 2)}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {balance.symbol}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Solana devnet
                    </span>
                  </div>
                </div>
                <span className="text-sm">
                  {formatToken(balance.amount, balance.symbol)}
                </span>
              </div>
            ))}
            {!data.balances.length ? (
              <p className="text-sm text-muted-foreground">
                No fundable strategy tokens are available.
              </p>
            ) : null}
            <div className="rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Network fees</span>
                <span>{formatToken(data.wallet.solBalance, "SOL", 5)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Available strategies</CardTitle>
            <CardDescription>
              Fundable devnet strategies returned by the SDP catalogue.
            </CardDescription>
          </div>
          <ShieldCheckIcon className="size-5 text-muted-foreground" />
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.strategies.map((strategy) => (
            <div
              key={strategy.id}
              className="flex flex-col justify-between gap-6 rounded-xl border p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-xs font-semibold uppercase">
                    {strategy.provider.slice(0, 2)}
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">
                      {strategy.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {titleCase(strategy.provider)}
                    </span>
                  </div>
                </div>
                <Badge variant="outline">{strategy.liquidityTerm}</Badge>
              </div>
              <div className="flex items-end justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    Current APY
                  </span>
                  <span className="text-xl font-semibold tracking-[-0.02em]">
                    {formatApy(strategy.currentApy)}
                  </span>
                </div>
                <DepositDialog
                  strategies={[strategy]}
                  balances={data.balances}
                  feesPaidBy={data.wallet.feesPaidBy}
                  busy={busy}
                  onSubmit={onDeposit}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>
              Movements recorded by Embedded Yield for this wallet.
            </CardDescription>
          </div>
          <Badge variant="outline">{data.movements.length} movements</Badge>
        </CardHeader>
        <CardContent>
          {data.movements.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Movement</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.movements.map((movement) => (
                  <TableRow key={movement.movementId}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-8 items-center justify-center rounded-full bg-muted">
                          {movement.direction === "deposit" ? (
                            <ArrowDownLeftIcon className="size-4" />
                          ) : (
                            <ArrowUpRightIcon className="size-4" />
                          )}
                        </span>
                        <span>
                          {movement.direction === "deposit"
                            ? "Yield deposit"
                            : "Yield withdrawal"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{titleCase(movement.provider)}</TableCell>
                    <TableCell>
                      <MovementStatus status={movement.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(movement.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <a
                        href={`https://explorer.solana.com/tx/${movement.signature}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
                      >
                        {movement.direction === "deposit" ? "-" : "+"}
                        {movement.amount}
                        <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
              Your first deposit will appear here.
            </div>
          )}
        </CardContent>
      </Card>

      <footer className="flex flex-col gap-2 border-t pt-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>
          {data.connection.apiLabel} ·{" "}
          {data.connection.projectScoped
            ? "Explicit project"
            : "API key project"}
        </span>
        <span title={data.wallet.address}>
          Managed wallet {shortAddress(data.wallet.address)} · Updated{" "}
          {formatDate(data.connection.checkedAt)}
        </span>
      </footer>
    </div>
  );
}

function BalanceMetric({
  label,
  value,
  positive = false,
  unavailable = false,
}: {
  label: string;
  value: string;
  positive?: boolean;
  unavailable?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-b px-6 py-5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={
          positive && value.startsWith("+")
            ? "text-sm font-medium text-success"
            : "text-sm font-medium"
        }
      >
        {value}
      </span>
      {unavailable ? (
        <span className="text-xs text-muted-foreground">
          Waiting for live position data
        </span>
      ) : null}
    </div>
  );
}

function PositionRow({
  position,
  tokenSymbol,
  feesPaidBy,
  busy,
  onWithdraw,
}: {
  position: YieldPosition;
  tokenSymbol: string;
  feesPaidBy: "customer" | "northstar";
  busy: boolean;
  onWithdraw: (positionId: string, shares: string) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-muted">
          <WalletCardsIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{position.label}</span>
          <span className="text-xs text-muted-foreground">
            {titleCase(position.provider)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-5 sm:justify-end">
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-sm font-medium">
            {position.tokenValue === undefined
              ? "Not available"
              : formatToken(position.tokenValue, tokenSymbol)}
          </span>
          <span className="text-xs text-muted-foreground">
            {position.shares === undefined
              ? "Shares unavailable"
              : `${position.shares} shares`}
          </span>
        </div>
        <WithdrawDialog
          positions={[position]}
          feesPaidBy={feesPaidBy}
          initialPositionId={position.id}
          busy={busy}
          onSubmit={onWithdraw}
          trigger={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={position.withdrawableShares === undefined}
            >
              Withdraw
            </Button>
          }
        />
      </div>
    </div>
  );
}

function EmptyYield() {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted">
        <WalletCardsIcon className="size-4" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Your cash can do more</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Choose a devnet strategy to put part of your balance to work.
        </p>
      </div>
    </div>
  );
}

function MovementStatus({ status }: { status: string }) {
  if (status === "finalized") {
    return (
      <Badge variant="outline" className="status-success">
        <CheckCircle2Icon />
        Finalized
      </Badge>
    );
  }
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return (
    <Badge variant="secondary">
      <LoaderCircleIcon className="animate-spin" />
      {titleCase(status)}
    </Badge>
  );
}
