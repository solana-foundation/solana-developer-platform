"use client";

import type {
  EarnPortfolioPosition,
  EarnPortfolioTargetAllocations,
  EarnPortfolioWalletActivity,
  EarnPortfolioWalletStatus,
  EarnStrategy,
} from "@sdp/types";
import { CheckIcon, CopyIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { fundableStrategies } from "./deposit/earn-deposit-model";
import { shortenAddress } from "./deposit/earn-funding-wallets";
import { formatApy, formatUsd } from "./earn-format";
import {
  EARN_PORTFOLIO_PROVIDER,
  type EarnProgram,
  useEarnProgram,
  useEarnStrategies,
  useEarnWalletActivityToasts,
  useEarnWithdrawalOutcomeToast,
} from "./earn-program-data";
import {
  settlementDays,
  strategyApy,
  strategySourceLabel,
  useLiquidityLabel,
} from "./earn-program-presentation";
import { EarnWithdrawModal } from "./earn-withdraw-modal";

const DEPOSIT_PATH = "/dashboard/markets/earn/deposit";

const WALLET_STATUS_BADGES: Partial<
  Record<EarnPortfolioWalletStatus, { variant: "default" | "warning" | "danger"; key: MessageKey }>
> = {
  creating: { variant: "warning", key: "DashboardEarn.overview.walletStatusCreating" },
  // Neutral, not amber: money moving exactly as asked — or the provider
  // rebalancing on its own schedule — is a fact, not a caution. That leaves
  // amber for `creating` (no deposit address exists yet, so the reader is
  // genuinely gated) and red for `failed`.
  busy: { variant: "default", key: "DashboardEarn.overview.walletStatusBusy" },
  failed: { variant: "danger", key: "DashboardEarn.overview.walletStatusFailed" },
};

/**
 * Copy for the named operation behind `busy`.
 *
 * The provider is the source of truth for what is happening to the money; this
 * only translates the provider-neutral activity the client already derived
 * (`EarnPortfolioWalletActivity`) into words. No provider status string appears
 * on this surface — that vocabulary lives in exactly one place, the provider
 * client's own status table. Nothing here infers state from what the user just
 * did either, so a rebalance the provider started by itself reads as
 * truthfully as a withdrawal the user submitted.
 *
 * An absent activity (wallet not busy, or a provider state this build does not
 * recognize) falls through to the generic label rather than guessing.
 */
const WALLET_ACTIVITY_KEYS: Record<EarnPortfolioWalletActivity, MessageKey> = {
  withdrawing: "DashboardEarn.overview.walletStatusWithdrawing",
  rebalancing: "DashboardEarn.overview.walletStatusRebalancing",
};

const SKELETON_ITEM_IDS = ["one", "two", "three"];

interface HoldingRow {
  position: EarnPortfolioPosition;
  /** Catalogue row behind a yield-source slice, when it resolves. */
  strategy: EarnStrategy | undefined;
}

/**
 * Portfolio slices as a flat, value-ordered list.
 *
 * Deliberately NOT grouped by curator: the deposit flow selects a strategy
 * directly, so a curator layer here would be a second, contradictory mental
 * model. Cash and in-transit slices sort last so the list still sums to the
 * wallet total without needing a separate group.
 */
function buildHoldings(
  positions: readonly EarnPortfolioPosition[],
  provider: string,
  strategies: readonly EarnStrategy[]
): readonly HoldingRow[] {
  const byReference = new Map(
    strategies
      .filter((strategy) => strategy.provider === provider)
      .map((strategy) => [strategy.providerReference, strategy] as const)
  );

  return positions
    .filter(
      // Ground keeps reporting a lane's residual cash bucket at $0 after it
      // drains (e.g. the Sepolia USDT lane once emptied) — provider plumbing,
      // not a holding. Zero-value non-strategy slices say nothing actionable
      // on SDP's Solana-only surface, so they never render. NONZERO value
      // always renders, whatever rail it sits on: hiding real dollars would
      // leave this list not summing to the wallet total Ground reports.
      (position) => position.kind === "yield_source" || Number(position.valueUsd) > 0
    )
    .map((position) => ({
      position,
      strategy:
        position.yieldSourceId === undefined ? undefined : byReference.get(position.yieldSourceId),
    }))
    .sort((left, right) => {
      const leftDeployed = left.position.kind === "yield_source";
      const rightDeployed = right.position.kind === "yield_source";
      if (leftDeployed !== rightDeployed) return leftDeployed ? -1 : 1;
      return Number(right.position.valueUsd) - Number(left.position.valueUsd);
    });
}

function WalletStatusBadge({ program }: { program: EarnProgram | undefined }) {
  const t = useTranslations();
  const wallet = program?.wallet;
  const badge = wallet ? WALLET_STATUS_BADGES[wallet.status] : undefined;
  if (!wallet || !badge) return null;
  const key = wallet.activity ? WALLET_ACTIVITY_KEYS[wallet.activity] : badge.key;
  return <Badge variant={badge.variant}>{t(key)}</Badge>;
}

function ProgramSkeleton() {
  return (
    <div aria-busy="true" className="mt-6 grid gap-3">
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
        {SKELETON_ITEM_IDS.map((id) => (
          <SkeletonBlock className="h-16 w-full rounded-md" key={id} />
        ))}
      </div>
      <SkeletonBlock className="h-16 w-full rounded-xl" />
    </div>
  );
}

function HoldingsList({
  allocations,
  rows,
}: {
  allocations: EarnPortfolioTargetAllocations;
  rows: readonly HoldingRow[];
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();

  /**
   * What a cash slice is waiting for, read from the program's own target
   * allocations. A lane whose target is a yield source deploys on the next
   * provider rebalance; a lane targeting `cash` is parked by design — Ground
   * never converts between stablecoins, so without this line a USDT balance
   * beside a USDC strategy reads as "stuck" when it is exactly on target.
   */
  const cashStatus = (position: EarnPortfolioPosition): string | null => {
    if (position.kind !== "cash" || !position.token) return null;
    const lane = allocations[position.token];
    if (!lane || lane.length === 0) return null;
    const deploys = lane.some((entry) => entry.yieldSourceId !== "cash" && entry.weightBps > 0);
    return t(deploys ? "DashboardEarn.overview.cashDeploys" : "DashboardEarn.overview.cashParked");
  };

  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-primary">
        {t("DashboardEarn.overview.holdingsTitle")}
      </h3>
      <ul className="mt-3 divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-default">
        {rows.map(({ position, strategy }) => (
          <li
            className="grid gap-2 bg-surface-raised px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            key={position.yieldSourceId ?? `${position.kind}:${position.label}`}
          >
            <div className="min-w-0">
              {/* Labels arrive display-ready from the provider client — never
                  rebuilt here, so no other chain's name can leak into the UI. */}
              <p className="truncate text-sm text-primary">{strategy?.name ?? position.label}</p>
              <p className="mt-0.5 truncate text-xs leading-5 text-secondary">
                {[
                  strategy ? liquidityLabel(strategy) : null,
                  strategy ? strategySourceLabel(strategy) : null,
                  cashStatus(position),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="sm:text-right">
              <p className="text-sm text-primary tabular-nums">{formatUsd(position.valueUsd)}</p>
              {strategy?.currentApy ? (
                <p className="mt-0.5 text-xs text-secondary tabular-nums">
                  {formatApy(strategy.currentApy)}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The funding loop, kept on the dashboard: after the flow finishes, this row is
 * how an operator gets the deposit address again without re-walking the wizard.
 * Copy puts the FULL address on the clipboard; the row shows it shortened.
 */
function DepositAddressRow({ address }: { address: string | undefined }) {
  const t = useTranslations();
  const { copied, copy } = useCopy(1800);
  if (!address) return null;

  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
      <div className="min-w-0">
        <p className="text-xs text-tertiary">{t("DashboardEarn.overview.depositAddressLabel")}</p>
        <p className="mt-0.5 text-sm text-primary">{shortenAddress(address)}</p>
      </div>
      <Button
        iconLeft={copied ? <CheckIcon /> : <CopyIcon />}
        onClick={() => void copy(address)}
        size="sm"
        type="button"
        variant="secondary"
      >
        {t(copied ? "DashboardEarn.deposit.copied" : "DashboardEarn.deposit.copy")}
      </Button>
    </div>
  );
}

function ProgramSection() {
  const t = useTranslations();
  const { state, error, isLoading, refresh } = useEarnProgram();
  // Owned here, not in the hook: the program read runs in several components,
  // and a toast per consumer would announce one completion several times.
  useEarnWalletActivityToasts(state);
  const { strategies } = useEarnStrategies();
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // Held past the modal's lifetime on purpose: the outcome lands well after
  // the user dismisses it, and it is the withdrawal — not the wallet — that
  // knows whether the money arrived.
  const [watchedWithdrawalRef, setWatchedWithdrawalRef] = useState<string | undefined>(undefined);
  useEarnWithdrawalOutcomeToast(watchedWithdrawalRef);

  const program = state?.kind === "active" ? state.program : undefined;
  const holdings = useMemo(
    () =>
      program
        ? buildHoldings(program.wallet.positions, program.provider, strategies ?? [])
        : ([] as readonly HoldingRow[]),
    [program, strategies]
  );

  return (
    <section className="rounded-xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {/* Polite live region: the badge now appears and clears on its own
              as the provider's status changes, so a screen-reader user would
              otherwise never learn a withdrawal started or settled. Not atomic
              — only the badge is announced, never the re-read heading. */}
          <div aria-live="polite" className="flex items-center gap-2">
            <h2 className="text-base font-medium tracking-tight text-primary">
              {t("DashboardEarn.overview.programTitle")}
            </h2>
            <WalletStatusBadge program={program} />
          </div>
          <p className="mt-1 max-w-xl text-sm leading-6 text-secondary">
            {t(
              program
                ? "DashboardEarn.overview.programDescription"
                : "DashboardEarn.overview.programEmpty"
            )}
          </p>
        </div>
        {program ? (
          // The two verbs that MANAGE the pot. Depositing needs no wizard at
          // all — it is the address row below — so nothing here says "deposit".
          <div className="flex w-full gap-2 sm:w-auto sm:shrink-0">
            <Button
              className="flex-1 sm:flex-none"
              disabled={Number(program.wallet.balance.withdrawableUsd) <= 0}
              onClick={() => setWithdrawOpen(true)}
              variant="secondary"
            >
              {t("DashboardEarn.overview.withdraw")}
            </Button>
            <Button asChild className="flex-1 sm:flex-none">
              <Link data-earn-withdraw-focus-fallback href={DEPOSIT_PATH}>
                {t("DashboardEarn.overview.changeStrategy")}
              </Link>
            </Button>
          </div>
        ) : null}
      </div>

      {isLoading ? <ProgramSkeleton /> : null}

      {error ? (
        <div className="mt-4 flex items-center gap-3 rounded-md border border-border-subtle bg-fill-subtle p-3">
          <p className="flex-1 text-sm text-secondary">
            {t("DashboardEarn.overview.programLoadError")}
          </p>
          <Button onClick={refresh} size="sm" variant="secondary">
            {t("Shared.SharedComponents.retry")}
          </Button>
        </div>
      ) : null}

      {state?.kind === "unconfigured" ? (
        <p className="mt-4 rounded-md border border-border-subtle bg-fill-subtle p-3 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.providerNotConfigured")}
        </p>
      ) : null}

      {program ? (
        <>
          <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                id: "total",
                label: t("DashboardEarn.overview.totalBalance"),
                value: formatUsd(program.wallet.balance.totalUsd),
              },
              {
                id: "earned",
                label: t("DashboardEarn.overview.totalEarned"),
                value: formatUsd(program.wallet.balance.earnedUsd),
              },
              {
                id: "withdrawable",
                label: t("DashboardEarn.overview.withdrawableBalance"),
                value: formatUsd(program.wallet.balance.withdrawableUsd),
              },
              {
                id: "apy",
                label: t("DashboardEarn.overview.currentApy"),
                // Undefined rate (all-cash program, or a yield lookup that
                // failed) reads as "no rate yet" — never a misleading 0%.
                value: program.yield?.currentApy ? formatApy(program.yield.currentApy) : "—",
              },
            ].map((tile) => (
              <div className="min-w-0 border-t border-border-subtle pt-3" key={tile.id}>
                <dt className="text-xs text-tertiary">{tile.label}</dt>
                <dd className="mt-1 text-2xl font-medium tracking-tight text-primary tabular-nums">
                  {tile.value}
                </dd>
              </div>
            ))}
          </dl>

          {holdings.length > 0 ? (
            <HoldingsList allocations={program.wallet.allocations} rows={holdings} />
          ) : (
            <p className="mt-6 text-sm leading-6 text-secondary">
              {t("DashboardEarn.overview.holdingsEmpty")}
            </p>
          )}

          <DepositAddressRow address={program.wallet.solanaDepositAddress} />
        </>
      ) : null}

      {withdrawOpen && program ? (
        <EarnWithdrawModal
          balance={program.wallet.balance}
          positions={program.wallet.positions}
          onClose={() => setWithdrawOpen(false)}
          onWithdrawalCreated={(withdrawalRef) => {
            setWatchedWithdrawalRef(withdrawalRef);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Onboarding hero, shown only while no program exists. States what the live
 * catalogue actually offers — count, best rate, fastest access — and routes
 * straight into the deposit flow. No curator grid: the flow no longer asks the
 * reader to pick a manager before they know what they are buying.
 */
function StartSection() {
  const t = useTranslations();
  const { state } = useEarnProgram();
  const { strategies, error, isLoading } = useEarnStrategies();

  // Nothing until the program read RESOLVES. `undefined` is in-flight, not
  // "no program": rendering the hero on it flashed onboarding at every reader
  // who already has a program, then yanked it away when the response landed.
  // Resolved non-active states (none / unconfigured) still get the hero, and
  // a failed read shows ProgramSection's error instead of guessing.
  if (state === undefined || state.kind === "active") {
    return null;
  }

  // Exactly what the deposit flow will offer: the pinned provider's active rows
  // that map to a fundable stablecoin lane. Counting anything else makes the
  // hero promise options the flow then filters away.
  const fundable = fundableStrategies(
    (strategies ?? []).filter(
      (strategy) => strategy.provider === EARN_PORTFOLIO_PROVIDER && strategy.status === "active"
    )
  );
  const apys = fundable
    .map((strategy) => strategyApy(strategy))
    .filter((apy): apy is number => apy !== undefined);
  const fastest = fundable.length > 0 ? Math.min(...fundable.map(settlementDays)) : undefined;

  const stats = [
    {
      id: "strategies",
      label: t("DashboardEarn.overview.startStatStrategies"),
      value: isLoading ? "—" : String(fundable.length),
    },
    {
      id: "apy",
      label: t("DashboardEarn.overview.startStatTopApy"),
      value: apys.length > 0 ? formatApy(String(Math.max(...apys))) : "—",
    },
    {
      id: "access",
      label: t("DashboardEarn.overview.startStatAccess"),
      value:
        fastest === undefined
          ? "—"
          : fastest === 0
            ? t("DashboardEarn.liquidity.instant")
            : t("DashboardEarn.liquidity.delayed", { days: fastest }),
    },
  ];

  return (
    <section className="rounded-xl border border-border-default bg-surface-raised p-6">
      <div className="max-w-2xl">
        <h2 className="text-base font-medium tracking-tight text-primary">
          {t("DashboardEarn.overview.startTitle")}
        </h2>
        <p className="mt-1 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.startDescription")}
        </p>
      </div>

      <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <div className="min-w-0 border-t border-border-subtle pt-3" key={stat.id}>
            <dt className="text-xs text-tertiary">{stat.label}</dt>
            <dd className="mt-1 text-2xl font-medium tracking-tight text-primary tabular-nums">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      {error ? (
        <p className="mt-5 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.catalogueLoadError")}
        </p>
      ) : null}

      {!isLoading && !error && fundable.length === 0 ? (
        <p className="mt-5 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.catalogueEmpty")}
        </p>
      ) : null}

      <div className="mt-6">
        <Button asChild>
          <Link href={DEPOSIT_PATH}>{t("DashboardEarn.overview.startAction")}</Link>
        </Button>
      </div>

      <p className="mt-5 max-w-3xl text-xs leading-5 text-muted">
        {t("DashboardEarn.overview.rateDisclosure")}
      </p>
    </section>
  );
}

export function EarnWorkspace() {
  return (
    // No root padding: the dashboard shell already pads non-viewport-locked routes.
    <div className="grid content-start gap-6">
      <ProgramSection />
      <StartSection />
    </div>
  );
}
