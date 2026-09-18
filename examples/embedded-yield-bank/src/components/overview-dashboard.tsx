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
import type { DashboardData, YieldMovement } from "@/types";
import { arrivalCopy, TransferDialog } from "./transfer-dialog";

interface OverviewDashboardProps {
  data: DashboardData;
  refreshing: boolean;
  busy: boolean;
  onRefresh: () => void;
  onDeposit: (amount: string) => Promise<void>;
  onWithdraw: (amount: string) => Promise<void>;
}

export function OverviewDashboard({
  data,
  refreshing,
  busy,
  onRefresh,
  onDeposit,
  onWithdraw,
}: OverviewDashboardProps) {
  const { token, checking, savings, wallet, connection } = data;
  const { strategy } = savings;
  const settling = data.movements.filter(isPendingMovement);
  const earningsUpdating = data.movements.some(isMovementAwaitingFinality);
  const depositsOpen = strategy.fundable && strategy.status === "active";

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
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
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
          <span className="flex min-h-5 items-center text-sm text-muted-foreground">
            {settling.length ? (
              <Badge variant="outline" className="status-warning">
                <span className="status-dot status-dot-live" />
                {settlingCopy(settling, token.symbol)}
              </Badge>
            ) : data.total === undefined ? (
              "Savings is being valued. Checking is shown for now."
            ) : null}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <TransferDialog
            direction="to-savings"
            symbol={token.symbol}
            available={checking.balance}
            strategy={strategy}
            feesPaidBy={wallet.feesPaidBy}
            busy={busy}
            disabledReason={
              !depositsOpen
                ? "Savings is not accepting deposits right now"
                : checking.balance === "0"
                  ? "Add funds to checking first"
                  : undefined
            }
            onSubmit={onDeposit}
          />
          <TransferDialog
            direction="to-checking"
            variant="outline"
            symbol={token.symbol}
            available={savings.withdrawable}
            strategy={strategy}
            feesPaidBy={wallet.feesPaidBy}
            busy={busy}
            disabledReason={
              savings.position === null
                ? "Nothing in savings yet"
                : savings.withdrawable === undefined
                  ? "Savings balance is still updating"
                  : savings.withdrawable === "0"
                    ? "Nothing available to move right now"
                    : undefined
            }
            onSubmit={onWithdraw}
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
          amount={
            savings.balance === undefined
              ? "—"
              : formatAmount(savings.balance, token.symbol)
          }
          {...savingsDetail(savings, token.symbol, earningsUpdating)}
          footer={`${strategy.name} · ${
            strategy.liquidityTerm === "instant"
              ? "Withdraw anytime"
              : `Withdrawals arrive ${arrivalCopy(strategy).toLowerCase()}`
          }`}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold tracking-[-0.01em]">
          Recent activity
        </h2>
        {data.movements.length ? (
          <ul className="divide-y rounded-2xl border">
            {data.movements.map((movement) => (
              <ActivityRow
                key={movement.movementId}
                movement={movement}
                symbol={token.symbol}
              />
            ))}
          </ul>
        ) : (
          <div className="flex min-h-28 items-center justify-center rounded-2xl border border-dashed text-sm text-muted-foreground">
            Your transfers will show up here.
          </div>
        )}
      </section>

      <footer className="flex flex-wrap items-center gap-x-2 border-t pt-5 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="status-dot text-success" />
          Solana devnet
        </span>
        <Dot />
        Updated {formatTime(connection.checkedAt)}
      </footer>
    </div>
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
}: {
  movement: YieldMovement;
  symbol: string;
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
          href={`https://explorer.solana.com/tx/${movement.signature}?cluster=devnet`}
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
