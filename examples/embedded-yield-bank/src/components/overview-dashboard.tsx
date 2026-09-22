import {
  CopyIcon,
  ExternalLinkIcon,
  LandmarkIcon,
  PiggyBankIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatAmount,
  formatApy,
  formatDate,
  formatTime,
  shortAddress,
} from "@/lib/format";
import {
  isMovementAwaitingFinality,
  isPendingMovement,
  isSettledMovement,
} from "@/lib/movements";
import { cn } from "@/lib/utils";
import type {
  DashboardData,
  WithdrawalIntent,
  YieldMovement,
  YieldWithdrawalRequest,
} from "@/types";
import { arrivalCopy, TransferDialog } from "./transfer-dialog";

interface OverviewDashboardProps {
  data: DashboardData;
  refreshing: boolean;
  busy: boolean;
  onRefresh: () => void;
  onDeposit: (amount: string) => Promise<void>;
  onWithdraw: (input: WithdrawalIntent) => Promise<void>;
  onCancelQueuedWithdrawal: (withdrawalRequestId: string) => Promise<void>;
}

export function OverviewDashboard({
  data,
  refreshing,
  busy,
  onRefresh,
  onDeposit,
  onWithdraw,
  onCancelQueuedWithdrawal,
}: OverviewDashboardProps) {
  const { token, checking, savings, wallet, connection } = data;
  const { strategy } = savings;
  const settling = data.movements.filter(isPendingMovement);
  const earningsUpdating = data.movements.some(isMovementAwaitingFinality);

  async function copyWalletAddress() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      toast.success("Wallet address copied");
    } catch {
      toast.error("Could not copy the wallet address");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-5 py-8 sm:px-8 sm:py-10 xl:py-12">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-[28px]">
            Good morning, Alex
          </h1>
          <p className="text-sm text-muted-foreground">
            Here is where your money stands today.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          aria-label="Refresh balances"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
        </Button>
      </header>

      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>Total balance</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground/60 tabular-nums transition-colors hover:text-foreground"
              aria-label={`Copy wallet address ${wallet.address}`}
              title={wallet.address}
              onClick={() => void copyWalletAddress()}
            >
              {shortAddress(wallet.address)}
              <CopyIcon className="size-3" />
            </button>
          </div>
          <span className="text-5xl font-semibold tracking-[-0.045em] tabular-nums sm:text-6xl">
            {formatAmount(data.total ?? checking.balance, token.symbol)}
          </span>
          {/* Fixed height so the buttons below never jump when this toggles. */}
          <TotalBalanceStatus
            settling={settling}
            total={data.total}
            symbol={token.symbol}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <TransferDialog
            direction="to-savings"
            symbol={token.symbol}
            available={checking.balance}
            strategy={strategy}
            feesPaidBy={wallet.feesPaidBy}
            busy={busy}
            disabledReason={depositDisabledReason(
              strategy.fundable && strategy.status === "active",
              checking.balance
            )}
            onSubmit={(input) => onDeposit(input.amount)}
          />
          <TransferDialog
            direction="to-checking"
            variant="outline"
            symbol={token.symbol}
            available={savings.withdrawable}
            strategy={strategy}
            withdrawalOptions={savings.withdrawalOptions}
            feesPaidBy={wallet.feesPaidBy}
            busy={busy}
            disabledReason={withdrawalDisabledReason(savings)}
            onSubmit={(input) =>
              input.route === "deposit"
                ? Promise.reject(new Error("Invalid withdrawal route"))
                : onWithdraw(input)
            }
          />
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <AccountCard
          icon={LandmarkIcon}
          name="Checking"
          amount={formatAmount(checking.balance, token.symbol)}
          detail="Available now"
          footer={`${token.symbol} on Solana`}
        />
        <AccountCard
          icon={PiggyBankIcon}
          name="Savings"
          badge={formatApy(strategy.currentApy)}
          amount={savingsBalance(savings.balance, token.symbol)}
          {...savingsDetail(savings, token.symbol, earningsUpdating)}
          footer={savingsFooter(savings)}
        />
      </section>

      <QueuedWithdrawals
        requests={data.withdrawalRequests}
        symbol={token.symbol}
        busy={busy}
        onCancel={onCancelQueuedWithdrawal}
      />

      <RecentActivity
        movements={data.movements}
        symbol={token.symbol}
        cluster={wallet.cluster}
      />

      <footer className="flex flex-wrap items-center gap-x-2 border-t pt-5 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="status-dot text-success" />
          Solana {wallet.cluster === "mainnet-beta" ? "mainnet" : "devnet"}
        </span>
        <Dot />
        Updated {formatTime(connection.checkedAt)}
      </footer>
    </div>
  );
}

function TotalBalanceStatus({
  settling,
  total,
  symbol,
}: {
  settling: YieldMovement[];
  total?: string;
  symbol: string;
}) {
  if (settling.length) {
    return (
      <span className="flex min-h-5 items-center text-sm text-muted-foreground">
        <Badge variant="outline" className="status-warning">
          <span className="status-dot status-dot-live" />
          {settlingCopy(settling, symbol)}
        </Badge>
      </span>
    );
  }
  return (
    <span className="flex min-h-5 items-center text-sm text-muted-foreground">
      {total === undefined
        ? "Savings is being valued. Checking is shown for now."
        : null}
    </span>
  );
}

function depositDisabledReason(
  depositsOpen: boolean,
  checkingBalance: string
): string | undefined {
  if (!depositsOpen) return "Savings is not accepting deposits right now";
  if (checkingBalance === "0") return "Add funds to checking first";
  return undefined;
}

function withdrawalDisabledReason(
  savings: DashboardData["savings"]
): string | undefined {
  if (savings.position === null) return "Nothing in savings yet";
  if (savings.balance === undefined || savings.withdrawable === undefined)
    return "Savings balance is still updating";
  if (savings.withdrawable === "0")
    return "Nothing available to move right now";
  if (!savings.withdrawalOptions)
    return "Withdrawal routes are temporarily unavailable";
  if (
    !savings.withdrawalOptions.instant &&
    !savings.withdrawalOptions.providerOrder &&
    !(
      savings.withdrawalOptions.queued &&
      savings.withdrawalOptions.queueAsset?.allowWithdrawals
    )
  ) {
    return "No supported withdrawal route is available right now";
  }
  return undefined;
}

function savingsBalance(balance: string | undefined, symbol: string): string {
  return balance === undefined ? "—" : formatAmount(balance, symbol);
}

function savingsFooter(savings: DashboardData["savings"]): string {
  const { strategy, withdrawalOptions } = savings;
  let availability = "Withdrawal routes updating";
  if (withdrawalOptions?.instant) availability = "Withdraw anytime";
  else if (withdrawalOptions?.providerOrder) {
    availability = `Withdrawals arrive ${arrivalCopy(strategy).toLowerCase()}`;
  } else if (withdrawalOptions?.queued) availability = "Queued withdrawals";
  return `${strategy.name} · ${availability}`;
}

function QueuedWithdrawals({
  requests,
  symbol,
  busy,
  onCancel,
}: {
  requests: YieldWithdrawalRequest[];
  symbol: string;
  busy: boolean;
  onCancel: (withdrawalRequestId: string) => Promise<void>;
}) {
  if (!requests.length) return null;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold tracking-[-0.01em]">
          Queued withdrawals
        </h2>
        <p className="text-sm text-muted-foreground">
          These shares are escrowed. A request is complete only after payment or
          share recovery.
        </p>
      </div>
      <ul className="divide-y rounded-2xl border">
        {requests.map((request) => (
          <li
            key={request.withdrawalRequestId}
            className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium">
                {formatAmount(request.quotedAssets, symbol)} expected
              </span>
              <span className="text-xs text-muted-foreground">
                {queuedWithdrawalStatusCopy(request)}
              </span>
              <span className="text-xs text-muted-foreground">
                Requested {formatDate(request.createdAt)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={queuedWithdrawalStatusClass(request.status)}
              >
                <span
                  className={cn(
                    "status-dot",
                    queuedWithdrawalStatusIsLive(request.status) &&
                      "status-dot-live"
                  )}
                />
                {queuedWithdrawalStatusLabel(request.status)}
              </Badge>
              {request.status === "expiredCancelable" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onCancel(request.withdrawalRequestId)}
                >
                  Get shares back
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function queuedWithdrawalStatusLabel(
  status: YieldWithdrawalRequest["status"]
): string {
  const labels: Record<YieldWithdrawalRequest["status"], string> = {
    creating: "Confirming",
    pending: "Queued",
    fulfillable: "Payment window",
    expiredCancelable: "Recovery available",
    cancelling: "Returning shares",
    fulfilled: "Paid",
    cancelled: "Recovered",
    closedOrUnknown: "Checking outcome",
    failed: "Failed",
  };
  return labels[status];
}

function queuedWithdrawalStatusClass(
  status: YieldWithdrawalRequest["status"]
): string {
  if (status === "fulfilled" || status === "cancelled") return "status-success";
  if (status === "failed")
    return "border-destructive/40 bg-destructive/5 text-destructive";
  return "status-warning";
}

function queuedWithdrawalStatusIsLive(
  status: YieldWithdrawalRequest["status"]
): boolean {
  return [
    "creating",
    "pending",
    "fulfillable",
    "cancelling",
    "closedOrUnknown",
  ].includes(status);
}

function queuedWithdrawalStatusCopy(request: YieldWithdrawalRequest): string {
  switch (request.status) {
    case "creating":
      return "Confirming the owner-signed request. No payout is credited yet.";
    case "pending":
      return `Solver payments can begin ${formatEpochSeconds(request.maturityTimestamp)}.`;
    case "fulfillable":
      return `Waiting for payment through ${formatEpochSeconds(request.deadlineTimestamp)}.`;
    case "expiredCancelable":
      return "The payment deadline passed. You can recover the escrowed shares.";
    case "cancelling":
      return "Share recovery was submitted. Payment can still win the race.";
    case "closedOrUnknown":
      return "SDP is verifying whether assets were paid or shares were returned.";
    case "fulfilled":
      return "The provider payout was finalized.";
    case "cancelled":
      return "The escrowed shares were returned.";
    case "failed":
      return request.failureReason ?? "The queued withdrawal failed.";
  }
}

function formatEpochSeconds(value: string): string {
  const milliseconds = Number(BigInt(value) * 1_000n);
  if (!Number.isSafeInteger(milliseconds)) return "at the provider time";
  return formatDate(new Date(milliseconds).toISOString());
}

function RecentActivity({
  movements,
  symbol,
  cluster,
}: {
  movements: YieldMovement[];
  symbol: string;
  cluster: DashboardData["wallet"]["cluster"];
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold tracking-[-0.01em]">
        Recent activity
      </h2>
      {movements.length ? (
        <ul className="divide-y rounded-2xl border">
          {movements.map((movement) => (
            <ActivityRow
              key={movement.movementId}
              movement={movement}
              symbol={symbol}
              cluster={cluster}
            />
          ))}
        </ul>
      ) : (
        <div className="flex min-h-28 items-center justify-center rounded-2xl border border-dashed text-sm text-muted-foreground">
          Your transfers will show up here.
        </div>
      )}
    </section>
  );
}

function settlingCopy(pending: YieldMovement[], symbol: string): string {
  const [movement] = pending;
  if (pending.length > 1 || !movement)
    return `${pending.length} transfers in progress`;
  const amount =
    movement.tokenAmount === null
      ? "money"
      : formatAmount(movement.tokenAmount, symbol);
  return `Moving ${amount} ${
    movement.direction === "deposit" ? "to savings" : "to checking"
  }`;
}

function Dot() {
  return <span aria-hidden="true">·</span>;
}

function savingsDetail(
  savings: DashboardData["savings"],
  symbol: string,
  earningsUpdating: boolean
): { detail: string; positive?: boolean } {
  if (savings.position === null && savings.earned === "0")
    return { detail: "Start earning with your first transfer" };
  if (savings.earned === undefined) {
    return {
      detail: earningsUpdating
        ? "Earnings accrue automatically"
        : "Earnings unavailable",
    };
  }
  if (savings.earned === "0") return { detail: "Nothing earned yet" };
  return {
    detail: `${formatAmount(savings.earned, symbol, { signed: true })} earned`,
    positive: !savings.earned.startsWith("-"),
  };
}

function AccountCard({
  icon: Icon,
  name,
  badge,
  amount,
  detail,
  positive = false,
  footer,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  name: string;
  badge?: string;
  amount: string;
  detail: string;
  positive?: boolean;
  footer: string;
}) {
  return (
    <div className="flex flex-col gap-6 rounded-2xl border p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-muted">
            <Icon className="size-4" />
          </span>
          <span className="text-sm font-medium">{name}</span>
        </div>
        {badge ? (
          <Badge variant="outline" className="status-success">
            {badge}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[28px] font-semibold tracking-[-0.03em] tabular-nums">
          {amount}
        </span>
        <span
          className={cn(
            "text-sm",
            positive ? "text-success" : "text-muted-foreground"
          )}
        >
          {detail}
        </span>
      </div>
      <span className="truncate text-xs text-muted-foreground" title={footer}>
        {footer}
      </span>
    </div>
  );
}

function ActivityRow({
  movement,
  symbol,
  cluster,
}: {
  movement: YieldMovement;
  symbol: string;
  cluster: DashboardData["wallet"]["cluster"];
}) {
  const toSavings = movement.direction === "deposit";
  const Icon = toSavings ? PiggyBankIcon : LandmarkIcon;
  return (
    <li className="flex items-center gap-4 px-4 py-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">
          {toSavings ? "To savings" : "To checking"}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {formatDate(movement.createdAt)}
          <MovementStatus movement={movement} />
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="text-sm font-medium tabular-nums">
          {movement.tokenAmount === null
            ? "—"
            : formatAmount(movement.tokenAmount, symbol)}
        </span>
        <a
          href={`https://explorer.solana.com/tx/${movement.signature}${
            cluster === "devnet" ? "?cluster=devnet" : ""
          }`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Receipt
          <ExternalLinkIcon className="size-3" />
        </a>
      </div>
    </li>
  );
}

function MovementStatus({ movement }: { movement: YieldMovement }) {
  if (isSettledMovement(movement)) {
    return (
      <Badge variant="outline" className="status-success">
        <span className="status-dot" />
        Settled
      </Badge>
    );
  }
  if (movement.status === "failed") {
    return (
      <Badge
        variant="outline"
        className="status-destructive"
        title={movement.failureReason ?? undefined}
      >
        <span className="status-dot" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="status-warning">
      <span className="status-dot status-dot-live" />
      Settling
    </Badge>
  );
}
