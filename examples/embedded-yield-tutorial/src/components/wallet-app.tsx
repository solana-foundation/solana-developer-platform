import {
  ArrowLeftRightIcon,
  CircleDollarSignIcon,
  CoinsIcon,
  CreditCardIcon,
  EuroIcon,
  HouseIcon,
  LoaderCircleIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
  UserIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { BalanceChart } from "@/components/balance-chart";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { balanceAfterDays, EARN_APY, EARN_PRINCIPAL } from "@/lib/yield";

function WalletHeader() {
  return (
    <div className="flex items-center justify-between px-5 pt-3">
      <div>
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Northstar Wallet
        </p>
        <p className="text-sm font-semibold text-foreground">
          Good morning, Ava
        </p>
      </div>
      <div className="flex size-9 items-center justify-center rounded-full border border-foreground/10 bg-app text-xs font-bold text-foreground">
        A
      </div>
    </div>
  );
}

function TabBar() {
  const tabs = [
    { label: "Home", icon: HouseIcon, active: true },
    { label: "Cards", icon: CreditCardIcon, active: false },
    { label: "Activity", icon: ArrowLeftRightIcon, active: false },
    { label: "Profile", icon: UserIcon, active: false },
  ];
  return (
    <nav className="absolute inset-x-0 bottom-0 flex items-center justify-around border-t border-foreground/10 bg-background/95 px-2 pt-2.5 pb-5 backdrop-blur">
      {tabs.map(({ label, icon: Icon, active }) => (
        <span
          key={label}
          className={`flex flex-col items-center gap-0.5 text-[10px] font-medium ${
            active ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          <Icon className="size-4.5" />
          {label}
        </span>
      ))}
    </nav>
  );
}

function AssetRow({
  icon,
  name,
  detail,
  balance,
  fiat,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
  balance: string;
  fiat: string;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-2.5">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground">{name}</p>
        <p className="text-[11px] text-muted-foreground">{detail}</p>
      </div>
      <div className="text-right">
        <p className="text-[13px] font-semibold text-foreground tabular-nums">
          {balance}
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">{fiat}</p>
      </div>
    </div>
  );
}

const currencyIconClass =
  "flex size-9 shrink-0 items-center justify-center rounded-full";

/** Step 1 screen: a plain custodial wallet holding USD, EUR, and USDC. */
export function CustodyScreen() {
  return (
    <div className="flex h-full flex-col">
      <WalletHeader />
      <div className="mx-5 mt-4 rounded-2xl bg-foreground p-4 text-background">
        <p className="text-[11px] text-background/60">Total balance</p>
        <p className="mt-1 text-[26px] font-semibold tabular-nums">
          $14,669.30
        </p>
        <p className="mt-1 flex items-center gap-1 text-[11px] text-background/60">
          <ShieldCheckIcon className="size-3" />3 currencies · USD, EUR, USDC
        </p>
      </div>
      <p className="mt-5 px-5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Your money
      </p>
      <div className="mt-1">
        <AssetRow
          icon={
            <span
              className={`${currencyIconClass} bg-[#059669]/10 text-[#059669]`}
            >
              <CircleDollarSignIcon className="size-5" />
            </span>
          }
          name="US Dollar"
          detail="Cash balance"
          balance="$1,240.50"
          fiat="USD"
        />
        <AssetRow
          icon={
            <span
              className={`${currencyIconClass} bg-[#4F46E5]/10 text-[#4F46E5]`}
            >
              <EuroIcon className="size-5" />
            </span>
          }
          name="Euro"
          detail="Cash balance"
          balance="€860.00"
          fiat="≈ $928.80"
        />
        <AssetRow
          icon={
            <span
              className={`${currencyIconClass} bg-[#2775CA]/10 text-[#2775CA]`}
            >
              <CoinsIcon className="size-5" />
            </span>
          }
          name="USDC"
          detail="Stablecoin · 1:1"
          balance="12,500.00 USDC"
          fiat="≈ $12,500.00"
        />
      </div>
      <TabBar />
    </div>
  );
}

export type EarnPhase =
  | "idle"
  | "pressing"
  | "confirming"
  | "accruing"
  | "done";

/** Step 3 screen: the same wallet, now with the Embedded Yield flow. */
export function EarnScreen({
  phase,
  day,
  onPress,
}: {
  phase: EarnPhase;
  day: number;
  onPress: () => void;
}) {
  const earning =
    phase === "confirming" || phase === "accruing" || phase === "done";
  const balance = balanceAfterDays(EARN_PRINCIPAL, EARN_APY, day);
  const earned = balance - EARN_PRINCIPAL;

  return (
    <div className="flex h-full flex-col">
      <WalletHeader />
      <div className="mx-5 mt-4 rounded-2xl bg-foreground p-4 text-background">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-[11px] text-background/60">
            <CoinsIcon className="size-3.5" />
            USDC · stablecoin
          </p>
          {earning ? (
            <p className="flex items-center gap-1.5 rounded-full bg-success/20 px-2 py-0.5 text-[10px] font-semibold text-[#7ee2b8]">
              <span className="animate-pulse-dot size-1.5 rounded-full bg-[#7ee2b8]" />
              Earning 8.43% APY
            </p>
          ) : null}
        </div>
        <p className="mt-1.5 text-[26px] font-semibold tabular-nums">
          {formatTokenAmount(balance)}
          <span className="ml-1 text-sm font-normal text-background/60">
            USDC
          </span>
        </p>
        <p className="mt-0.5 text-[11px] text-background/60 tabular-nums">
          ≈ {formatUsd(balance)}
        </p>
      </div>

      <div className="flex-1 px-5 pt-4">
        {phase === "idle" || phase === "pressing" ? (
          <button
            type="button"
            onClick={onPress}
            className={`flex w-full items-center justify-center gap-2 rounded-xl bg-success py-3 text-sm font-semibold text-white transition-transform duration-150 ${
              phase === "pressing" ? "scale-95 opacity-80" : "hover:opacity-90"
            }`}
          >
            {phase === "pressing" ? (
              <>
                <LoaderCircleIcon className="size-4 animate-spin" />
                Enabling Yield…
              </>
            ) : (
              <>
                <TrendingUpIcon className="size-4" />
                Earn 8.43%
              </>
            )}
          </button>
        ) : null}

        {phase === "confirming" ? (
          <div className="animate-toast rounded-xl border border-success/20 bg-success/10 p-3">
            <p className="text-[12px] font-semibold text-success">
              Yield turned on
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              Your USDC now earns through the Kamino Institutional Commodity
              Yield strategy via SDP Embedded Yield.
            </p>
          </div>
        ) : null}

        {phase === "accruing" || phase === "done" ? (
          <div className="rounded-xl border border-foreground/10 bg-background p-3">
            <div className="flex items-baseline justify-between">
              <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                Fast-forward · 30 days
              </p>
              <p className="text-[12px] font-semibold text-success tabular-nums">
                +{formatTokenAmount(earned)} USDC
              </p>
            </div>
            <BalanceChart day={day} />
            <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
              Day {Math.round(day)} of 30 · yield accrues daily
            </p>
          </div>
        ) : null}
      </div>
      <TabBar />
    </div>
  );
}
