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
  findProgram,
  hasPrograms,
  useEarnPrograms,
  useEarnStrategies,
  useEarnWalletActivityToasts,
  useEarnWithdrawalOutcomeToast,
} from "./earn-program-data";
import {
  portfolioTotals,
  programTitle,
  settlementDays,
  strategiesByReference,
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
  byReference: ReadonlyMap<string, EarnStrategy>
): readonly HoldingRow[] {
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

function WalletStatusBadge({ program }: { program: EarnProgram }) {
  const t = useTranslations();
  const wallet = program.wallet;
  const badge = WALLET_STATUS_BADGES[wallet.status];
  if (!badge) return null;
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

/**
 * The four money figures every strip shows. One builder, because the portfolio
 * strip and each program card must never drift on which figures render or on
 * the missing-rate rule: an undefined APY (all-cash program, failed yield
 * lookup, or an unratable blend) renders "—", never a fabricated 0%.
 */
function useMoneyTiles() {
  const t = useTranslations();
  return (
    balance: {
      totalUsd: number | string;
      earnedUsd: number | string;
      withdrawableUsd: number | string;
    },
    apy: { label: string; value: string | number | undefined }
  ) => [
    {
      id: "total",
      label: t("DashboardEarn.overview.totalBalance"),
      value: formatUsd(balance.totalUsd),
    },
    {
      id: "earned",
      label: t("DashboardEarn.overview.totalEarned"),
      value: formatUsd(balance.earnedUsd),
    },
    {
      id: "withdrawable",
      label: t("DashboardEarn.overview.withdrawableBalance"),
      value: formatUsd(balance.withdrawableUsd),
    },
    { id: "apy", label: apy.label, value: apy.value === undefined ? "—" : formatApy(apy.value) },
  ];
}

/** A stat strip — the same four figures, whether portfolio-wide or per program. */
function MoneyTiles({
  tiles,
  size,
}: {
  tiles: readonly { id: string; label: string; value: string }[];
  size: "lg" | "sm";
}) {
  return (
    <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <div className="min-w-0 border-t border-border-subtle pt-3" key={tile.id}>
          <dt className="text-xs text-tertiary">{tile.label}</dt>
          <dd
            className={`mt-1 font-medium tracking-tight text-primary tabular-nums ${
              size === "lg" ? "text-2xl" : "text-xl"
            }`}
          >
            {tile.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * ONE program: its own money, its own holdings, its own funding address, and the
 * two verbs that manage it. Rendered as a repeated record, so several stack
 * without a switcher — hiding a funded program behind a tab would make a reader
 * hunt for money they hold.
 */
function ProgramCard({
  program,
  strategies,
  onWithdraw,
}: {
  program: EarnProgram;
  strategies: readonly EarnStrategy[];
  onWithdraw: () => void;
}) {
  const t = useTranslations();
  const moneyTiles = useMoneyTiles();
  // One provider-filtered reference map serves both the title and the holdings
  // join — built per catalogue change, not per render, and filtered so another
  // provider's reference can never cross-match this program's slices.
  const catalogueByRef = useMemo(
    () => strategiesByReference(program.provider, strategies),
    [program.provider, strategies]
  );
  const holdings = useMemo(
    () => buildHoldings(program.wallet.positions, catalogueByRef),
    [program, catalogueByRef]
  );
  const title = programTitle(
    program.wallet.allocations,
    program.label,
    catalogueByRef,
    t("DashboardEarn.overview.programUntitled")
  );

  return (
    <article className="rounded-xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {/* Polite live region: the badge appears and clears on its own as the
              provider's status changes, so a screen-reader user would otherwise
              never learn a withdrawal started or settled. Not atomic — only the
              badge is announced, never the re-read heading. */}
          <div aria-live="polite" className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-medium tracking-tight text-primary">{title}</h3>
            <WalletStatusBadge program={program} />
          </div>
        </div>
        {/* The two verbs that MANAGE this program. Depositing needs no wizard at
            all — it is the address row below — so nothing here says "deposit". */}
        <div className="flex w-full gap-2 sm:w-auto sm:shrink-0">
          <Button
            className="flex-1 sm:flex-none"
            disabled={Number(program.wallet.balance.withdrawableUsd) <= 0}
            onClick={onWithdraw}
            variant="secondary"
          >
            {t("DashboardEarn.overview.withdraw")}
          </Button>
          <Button asChild className="flex-1 sm:flex-none" variant="secondary">
            {/* The attribute VALUE scopes the withdraw modal's focus-return
                fallback to THIS program's card — a bare attribute would make
                the modal's querySelector land on whichever card renders
                first. */}
            <Link
              data-earn-withdraw-focus-fallback={program.id}
              href={`${DEPOSIT_PATH}?program=${encodeURIComponent(program.id)}`}
            >
              {t("DashboardEarn.overview.changeStrategy")}
            </Link>
          </Button>
        </div>
      </div>

      <MoneyTiles
        size="sm"
        tiles={moneyTiles(program.wallet.balance, {
          label: t("DashboardEarn.overview.currentApy"),
          value: program.yield?.currentApy,
        })}
      />

      {holdings.length > 0 ? (
        <HoldingsList allocations={program.wallet.allocations} rows={holdings} />
      ) : (
        <p className="mt-6 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.holdingsEmpty")}
        </p>
      )}

      <DepositAddressRow address={program.wallet.solanaDepositAddress} />
    </article>
  );
}

/**
 * Renders nothing; exists because hooks are per-instance. Mounting one per
 * submitted withdrawal is what lets N in-flight withdrawals each poll to their
 * own terminal status and announce exactly once — and `onSettled` is how one
 * retires afterwards, so settled watchers do not accumulate as dead SWR
 * subscriptions over a long session.
 */
function WithdrawalOutcomeWatcher({
  programId,
  withdrawalRef,
  onSettled,
}: {
  programId: string;
  withdrawalRef: string;
  onSettled: () => void;
}) {
  useEarnWithdrawalOutcomeToast(programId, withdrawalRef, onSettled);
  return null;
}

/**
 * The API pages programs oldest-first so its public collection has a stable
 * head. The overview is a different presentation concern: once every page is
 * loaded, show the program the user just created first. Sort a copy so SWR's
 * cached collection is never mutated, and use the id to make timestamp ties
 * deterministic.
 */
function newestProgramsFirst(programs: readonly EarnProgram[]): EarnProgram[] {
  return [...programs].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  );
}

function ProgramsSection() {
  const t = useTranslations();
  const moneyTiles = useMoneyTiles();
  const { state, error, isLoading, refresh } = useEarnPrograms();
  // Owned here, not in the hook: the program read runs in several components,
  // and a toast per consumer would announce one completion several times.
  useEarnWalletActivityToasts(state);
  const { strategies } = useEarnStrategies();
  const [withdrawProgramId, setWithdrawProgramId] = useState<string | undefined>(undefined);
  // Held past the modal's lifetime on purpose: the outcome lands well after
  // the user dismisses it, and it is the withdrawal — not the wallet — that
  // knows whether the money arrived. A LIST, not a slot: with several programs
  // a user can submit a second withdrawal while the first still processes, and
  // a single slot would orphan the first watch — its outcome toast (including a
  // failure) would simply never fire. Each entry carries its program, since a
  // withdrawal is only addressable through the program that made it. Entries
  // retire themselves once announced (the watcher's onSettled), so the list
  // holds only in-flight watches.
  const [watched, setWatched] = useState<readonly { programId: string; withdrawalRef: string }[]>(
    []
  );

  const programs = state?.kind === "ready" ? state.programs : [];
  const listedPrograms = useMemo(() => newestProgramsFirst(programs), [programs]);
  const catalogue = strategies ?? [];
  const withdrawProgram = findProgram(state, withdrawProgramId);
  const totals = useMemo(() => portfolioTotals(programs), [programs]);

  // The portfolio strip only earns its place once there is something to add up.
  // With a single program it would restate that program's own tiles directly
  // above them.
  const showPortfolio = programs.length > 1;

  return (
    <>
      <section className="rounded-xl border border-border-default bg-surface-raised p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-medium tracking-tight text-primary">
              {t("DashboardEarn.overview.programTitle")}
            </h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-secondary">
              {t(
                programs.length > 0
                  ? "DashboardEarn.overview.programDescription"
                  : "DashboardEarn.overview.programEmpty"
              )}
            </p>
          </div>
          {programs.length > 0 ? (
            <div className="flex w-full sm:w-auto sm:shrink-0">
              <Button asChild className="flex-1 sm:flex-none">
                <Link href={DEPOSIT_PATH}>{t("DashboardEarn.overview.addStrategy")}</Link>
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

        {showPortfolio ? (
          <MoneyTiles
            size="lg"
            tiles={moneyTiles(totals, {
              label: t("DashboardEarn.overview.blendedApy"),
              value: totals.blendedApy,
            })}
          />
        ) : null}
      </section>

      {listedPrograms.map((program) => (
        <ProgramCard
          key={program.id}
          onWithdraw={() => setWithdrawProgramId(program.id)}
          program={program}
          strategies={catalogue}
        />
      ))}

      {watched.map((entry) => (
        <WithdrawalOutcomeWatcher
          key={`${entry.programId}:${entry.withdrawalRef}`}
          {...entry}
          onSettled={() =>
            setWatched((current) =>
              current.filter(
                (candidate) =>
                  candidate.programId !== entry.programId ||
                  candidate.withdrawalRef !== entry.withdrawalRef
              )
            )
          }
        />
      ))}

      {withdrawProgram ? (
        <EarnWithdrawModal
          // Remount per program so no draft amount, destination, or minted
          // idempotency key can survive a switch between programs.
          key={withdrawProgram.id}
          onClose={() => setWithdrawProgramId(undefined)}
          onWithdrawalCreated={(withdrawalRef) => {
            setWatched((current) => [...current, { programId: withdrawProgram.id, withdrawalRef }]);
            refresh();
          }}
          programId={withdrawProgram.id}
        />
      ) : null}
    </>
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
  const { state } = useEarnPrograms();
  const { strategies, error, isLoading } = useEarnStrategies();

  // Nothing until the program read RESOLVES. `undefined` is in-flight, not
  // "no programs": rendering the hero on it flashed onboarding at every reader
  // who already has one, then yanked it away when the response landed. A
  // resolved-but-empty list and `unconfigured` still get the hero, and a failed
  // read shows ProgramsSection's error instead of guessing.
  if (state === undefined || hasPrograms(state)) {
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
      <ProgramsSection />
      <StartSection />
    </div>
  );
}
