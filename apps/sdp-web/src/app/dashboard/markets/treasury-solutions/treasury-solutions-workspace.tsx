"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnProgramWithdrawalRecord,
  type EarnStrategy,
  type EarnVaultDirectMovementStatus,
  type EarnVaultMovementStatus,
  type EarnVaultPosition,
  type EarnVaultWithdrawal,
  earnProgramSolanaPayoutTokens,
  isVaultDirectDepositEnabled,
  type SdpEnvironment,
  SOLANA_CLUSTER_LABELS,
  SOLANA_CLUSTERS,
  type SolanaCluster,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { SegmentedControl } from "@solana/design-system/segmented-control";
import {
  ArrowDownLeftIcon,
  ArrowUpDownIcon,
  ArrowUpRightIcon,
  InfoIcon,
  RefreshCwIcon,
  WalletCardsIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";
import {
  type EarnFundingWallet,
  useEarnFundingWallets,
} from "../earn/deposit/earn-funding-wallets";
import { compareUnsignedDecimals } from "../earn/earn-decimal";
import { earnProviderLabel, formatUsd } from "../earn/earn-format";
import {
  earnMintAsset,
  earnStrategyAsset,
  earnStrategyReferenceKey,
  formatProviderAmount,
  formatProviderApy,
  shortenMarketAddress,
  sumDecimalStrings,
} from "../earn/earn-market-presentation";
import {
  type EarnProgram,
  type EarnVaultDepositRecord,
  isEarnVaultDepositInFlight,
  isEarnVaultWithdrawalInFlight,
  useEarnPrograms,
  useEarnProgramWithdrawals,
  useEarnStrategies,
  useEarnVaultDeposits,
  useEarnVaultPositions,
  useEarnVaultWithdrawals,
} from "../earn/earn-program-data";
import {
  type EarnProviderAccess,
  type EarnVaultDepositAvailability,
  earnVaultDepositAvailability,
} from "../earn/earn-surfacing";
import {
  EarnVaultDepositModal,
  EarnVaultDepositOutcomeTracker,
} from "../earn/earn-vault-deposit-modal";
import {
  EarnVaultWithdrawalOutcomeTracker,
  EarnVaultWithdrawModal,
} from "../earn/earn-vault-withdraw-modal";
import { EarnWithdrawalOutcomeTracker, EarnWithdrawModal } from "../earn/earn-withdraw-modal";
import {
  availableTreasuryCashForWallet,
  estimatedTreasuryApy,
  isOpenVaultPosition,
  summarizeTreasuryAllocation,
  type TreasuryAllocation,
} from "./treasury-allocation";

type TrackedVaultDeposit = Pick<
  EarnVaultDepositRecord,
  "failureReason" | "movementId" | "positionId" | "status"
> & { createdAt?: string; observedOrder: number };

type VaultDepositWatchInput = Omit<TrackedVaultDeposit, "observedOrder">;

type TrackedVaultWithdrawal = Pick<
  EarnVaultWithdrawal,
  "createdAt" | "failureReason" | "movementId" | "positionId" | "status"
> & { observedOrder: number };

type VaultWithdrawalWatchInput = Omit<TrackedVaultWithdrawal, "observedOrder">;

type TrackedVaultActivity =
  | { kind: "deposit"; movement: TrackedVaultDeposit }
  | { kind: "withdrawal"; movement: TrackedVaultWithdrawal };

const MAX_VISIBLE_VAULT_ACTIVITY = 50;

type NumericSortDirection = "ascending" | "descending";

function sortByOptionalDecimal<Item>(
  items: readonly Item[],
  valueFor: (item: Item) => string | undefined,
  direction: NumericSortDirection
): Item[] {
  return items
    .map((item, index) => {
      const candidate = valueFor(item);
      const value =
        candidate !== undefined && compareUnsignedDecimals(candidate, "0") !== undefined
          ? candidate
          : undefined;
      return { index, item, value };
    })
    .sort((left, right) => {
      if (left.value === undefined && right.value === undefined) return left.index - right.index;
      if (left.value === undefined) return 1;
      if (right.value === undefined) return -1;

      const order = compareUnsignedDecimals(left.value, right.value) ?? 0;
      if (order === 0) return left.index - right.index;
      return direction === "ascending" ? order : -order;
    })
    .map(({ item }) => item);
}

function SortableNumericTableHead({
  children,
  className,
  direction,
  onToggle,
}: {
  children: ReactNode;
  className?: string;
  direction: NumericSortDirection;
  onToggle: () => void;
}) {
  return (
    <TableHead aria-sort={direction} className={className}>
      <button
        className="-ml-1 inline-flex items-center gap-2 rounded-md px-1 py-1 text-left text-inherit transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
        onClick={onToggle}
        type="button"
      >
        <ArrowUpDownIcon aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
        <span>{children}</span>
      </button>
    </TableHead>
  );
}

function replaceTrackedVaultMovement<
  Movement extends { movementId: string },
  Update extends { movementId: string },
>(current: readonly Movement[], updated: Update): readonly Movement[] {
  return current.map((candidate) =>
    candidate.movementId === updated.movementId ? { ...candidate, ...updated } : candidate
  );
}

const TREASURY_DEPOSIT_STATUS = {
  pending: {
    description: "DashboardMarkets.treasury.depositStatusPendingDescription",
    label: "DashboardMarkets.treasury.depositStatusPending",
    variant: "warning",
  },
  submitted: {
    description: "DashboardMarkets.treasury.depositStatusSubmittedDescription",
    label: "DashboardMarkets.treasury.depositStatusSubmitted",
    variant: "default",
  },
  confirmed: {
    description: "DashboardMarkets.treasury.depositStatusConfirmedDescription",
    label: "DashboardMarkets.treasury.depositStatusConfirmed",
    variant: "success",
  },
  failed: {
    description: "DashboardMarkets.treasury.depositStatusFailedDescription",
    label: "DashboardMarkets.treasury.depositStatusFailed",
    variant: "danger",
  },
} as const satisfies Readonly<
  Record<
    EarnVaultMovementStatus,
    { description: MessageKey; label: MessageKey; variant: BadgeVariant }
  >
>;

const TREASURY_WITHDRAWAL_STATUS = {
  requested: {
    description: "DashboardMarkets.treasury.withdrawalStatusRequestedDescription",
    label: "DashboardMarkets.treasury.withdrawalStatusRequested",
    variant: "warning",
  },
  submitted: {
    description: "DashboardMarkets.treasury.withdrawalStatusSubmittedDescription",
    label: "DashboardMarkets.treasury.withdrawalStatusSubmitted",
    variant: "default",
  },
  confirmed: {
    description: "DashboardMarkets.treasury.withdrawalStatusConfirmedDescription",
    label: "DashboardMarkets.treasury.withdrawalStatusConfirmed",
    variant: "warning",
  },
  finalized: {
    description: "DashboardMarkets.treasury.withdrawalStatusFinalizedDescription",
    label: "DashboardMarkets.treasury.withdrawalStatusFinalized",
    variant: "success",
  },
  failed: {
    description: "DashboardMarkets.treasury.withdrawalStatusFailedDescription",
    label: "DashboardMarkets.treasury.withdrawalStatusFailed",
    variant: "danger",
  },
} as const satisfies Readonly<
  Record<
    EarnVaultDirectMovementStatus,
    { description: MessageKey; label: MessageKey; variant: BadgeVariant }
  >
>;

function TreasuryInfoTip({ label }: { label: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={label}
            className="inline-flex size-4 items-center justify-center rounded-full text-tertiary transition-colors hover:text-primary"
            type="button"
          >
            <InfoIcon aria-hidden="true" className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs leading-5">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TreasuryPositionStatusBadge({ activity }: { activity?: TrackedVaultActivity }) {
  const t = useTranslations();
  const status = activity
    ? activity.kind === "deposit"
      ? TREASURY_DEPOSIT_STATUS[activity.movement.status]
      : TREASURY_WITHDRAWAL_STATUS[activity.movement.status]
    : {
        description: "DashboardMarkets.treasury.positionStatusActiveDescription" as const,
        label: "DashboardMarkets.treasury.positionStatusActive" as const,
        variant: "outline" as const,
      };
  const description =
    activity?.movement.status === "failed" && activity.movement.failureReason
      ? activity.movement.failureReason
      : t(status.description);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={`${t(status.label)}: ${description}`}
            className="inline-flex cursor-help border-0 bg-transparent p-0"
            type="button"
          >
            <Badge variant={status.variant}>{t(status.label)}</Badge>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs leading-5">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TreasurySummaryFigure({
  description,
  label,
  showInfo = false,
  value,
}: {
  description: string;
  label: string;
  showInfo?: boolean;
  value: string;
}) {
  return (
    <Card className="min-h-[10.5rem] min-w-0 justify-center gap-0 rounded-2xl px-10 py-8">
      <dt className="flex items-center gap-1 text-sm leading-5 font-normal text-secondary">
        {label}
        {showInfo ? (
          <TreasuryInfoTip label={description} />
        ) : (
          <span aria-label={description} className="sr-only" role="note">
            {description}
          </span>
        )}
      </dt>
      <dd className="mt-4 text-[32px] leading-9 font-medium tracking-[-0.3px] text-primary tabular-nums [overflow-wrap:anywhere]">
        {value}
      </dd>
    </Card>
  );
}

function TreasuryAllocationCard({
  allocation,
  estimatedApy,
  isLoading,
}: {
  allocation: TreasuryAllocation;
  estimatedApy: string | undefined;
  isLoading: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        <SkeletonBlock className="h-[168px] rounded-2xl" />
        <SkeletonBlock className="h-[168px] rounded-2xl" />
        <SkeletonBlock className="h-[168px] rounded-2xl" />
      </div>
    );
  }

  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      <TreasurySummaryFigure
        description={t(
          allocation.deployedValue === undefined
            ? allocation.deployedAbsence === "unreconciled"
              ? "DashboardMarkets.treasury.summaryDeployedUnreconciled"
              : "DashboardMarkets.treasury.summaryDeployedUnavailable"
            : "DashboardMarkets.treasury.summaryDeployedCaption",
          allocation.deployedValue === undefined
            ? undefined
            : { value: formatUsd(allocation.deployedValue, locale, 2) }
        )}
        label={t("DashboardMarkets.treasury.summaryDeposited")}
        showInfo={allocation.deployedValue === undefined}
        value={formatUsd(allocation.deployedValue, locale, 2)}
      />
      <TreasurySummaryFigure
        description={t(
          allocation.availableCash === undefined
            ? "DashboardMarkets.treasury.summaryCashUnavailable"
            : "DashboardMarkets.treasury.summaryCashCaption"
        )}
        label={t("DashboardMarkets.treasury.summaryCash")}
        showInfo
        value={formatUsd(allocation.availableCash, locale, 2)}
      />
      <TreasurySummaryFigure
        description={t(
          estimatedApy === undefined
            ? "DashboardMarkets.treasury.summaryApyUnavailable"
            : "DashboardMarkets.treasury.summaryApyCaption"
        )}
        label={t("DashboardMarkets.treasury.summaryApy")}
        showInfo={estimatedApy === undefined}
        value={formatProviderApy(estimatedApy, locale)}
      />
    </dl>
  );
}

function TreasuryWalletsCard({
  allocation,
  error,
  isLoading,
  wallets,
}: {
  allocation: TreasuryAllocation;
  error: unknown;
  isLoading: boolean;
  wallets: readonly EarnFundingWallet[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-[19px] leading-6 font-medium text-primary">
          {t("DashboardMarkets.treasury.connectedWallets")}
        </h2>
        <Button asChild size="sm" variant="secondary">
          <Link href={DASHBOARD_SIDE_NAV_HREFS.wallets}>
            {t("DashboardMarkets.treasury.viewAll")}
          </Link>
        </Button>
      </div>
      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-3">
          <SkeletonBlock className="h-[175px] rounded-2xl" />
          <SkeletonBlock className="h-[175px] rounded-2xl" />
          <SkeletonBlock className="h-[175px] rounded-2xl" />
        </div>
      ) : error ? (
        <p className="text-sm text-secondary">{t("DashboardMarkets.treasury.walletsError")}</p>
      ) : wallets.length === 0 ? (
        <ListEmptyState
          description={t("DashboardMarkets.treasury.walletsEmptyDescription")}
          icon={<WalletCardsIcon aria-hidden="true" className="size-5" />}
          message={t("DashboardMarkets.treasury.walletsEmptyTitle")}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {wallets.map((wallet) => {
            // Straight from the same result the summary rendered, so the
            // two cannot disagree about this wallet.
            const deployment = allocation.deploymentByWalletId.get(wallet.id) ?? {
              kind: "none" as const,
            };
            return (
              <Card className="min-h-[158px] gap-0 rounded-2xl px-5 py-5" key={wallet.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] leading-5 font-medium text-primary">
                      {wallet.label?.trim() || t("DashboardMarkets.treasury.unnamedWallet")}
                    </h3>
                    <p className="mt-1 truncate text-sm text-tertiary" title={wallet.publicKey}>
                      {shortenMarketAddress(wallet.publicKey)}
                    </p>
                  </div>
                  <Badge variant="outline">
                    {wallet.provider ?? t("DashboardMarkets.treasury.walletProviderUnknown")}
                  </Badge>
                </div>
                <dl className="mt-5 divide-y divide-border-subtle overflow-hidden rounded-xl bg-fill-subtle px-4">
                  <div className="flex items-center justify-between gap-4 py-3">
                    <dt className="flex items-center gap-1 text-sm text-secondary">
                      {t("DashboardMarkets.treasury.summaryCash")}
                      <TreasuryInfoTip label={t("DashboardMarkets.treasury.summaryCashCaption")} />
                    </dt>
                    <dd className="text-sm text-primary tabular-nums">
                      {formatUsd(availableTreasuryCashForWallet(wallet), locale, 2)}
                    </dd>
                  </div>
                  {deployment.kind === "none" ? null : (
                    <div className="flex items-center justify-between gap-4 py-3">
                      <dt className="text-sm text-secondary">
                        {t("DashboardMarkets.treasury.walletDeployed")}
                      </dt>
                      <dd className="text-sm text-primary tabular-nums">
                        {deployment.kind === "value"
                          ? formatUsd(deployment.value, locale, 2)
                          : t("DashboardMarkets.treasury.positionValueUnavailable")}
                      </dd>
                    </div>
                  )}
                </dl>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function strategyPositionValue(
  strategy: EarnStrategy,
  positions: readonly EarnVaultPosition[] | undefined,
  /** Undefined when the witness is unavailable, so nothing can be certified. */
  unrecordedShareMints: ReadonlySet<string> | undefined
): { count: number; unrecorded?: boolean; value?: string } {
  const active = (positions ?? []).filter(
    (position) =>
      isOpenVaultPosition(position) &&
      earnStrategyReferenceKey(position.provider, position.providerReference) ===
        earnStrategyReferenceKey(strategy.provider, strategy.providerReference)
  );
  // Applies to a row WITH recorded positions too, not just an empty one: a
  // second wallet holding this vault's shares with no row behind them makes
  // the recorded figure a floor, and printing it would contradict the summary
  // and that wallet's card, which both read unavailable here. Without the
  // witness at all, "no active position" is equally unsupportable.
  const unrecorded =
    unrecordedShareMints === undefined ||
    (strategy.shareMint !== undefined && unrecordedShareMints.has(strategy.shareMint));
  if (unrecorded) return { count: active.length, unrecorded };
  if (active.length === 0) return { count: 0 };
  const values = active.map((position) => position.tokenValue);
  if (values.some((value) => value === undefined)) return { count: active.length };
  return { count: active.length, value: sumDecimalStrings(values as string[]) };
}

// Exhaustive by construction: a new availability variant fails this map's
// compile instead of collapsing to a bare "Unavailable".
const TREASURY_AVAILABILITY_LABELS = {
  available: "DashboardMarkets.treasury.depositAvailable",
  cluster_unavailable: "DashboardMarkets.treasury.clusterUnavailable",
  strategy_unavailable: "DashboardMarkets.treasury.depositUnavailable",
  environment_unavailable: "DashboardMarkets.treasury.productionUnavailable",
  access_unavailable: "DashboardMarkets.treasury.accessUnavailable",
  provider_unavailable: "DashboardMarkets.treasury.providerUnavailable",
} as const satisfies Readonly<Record<EarnVaultDepositAvailability, MessageKey>>;

function TreasuryPositionIdentity({ name, provider }: { name: string; provider: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-primary" title={name}>
        {name}
      </p>
      <p className="mt-0.5 truncate text-xs text-tertiary">{provider}</p>
    </div>
  );
}

function StrategyTable({
  environment,
  onDeposit,
  positions,
  providerAccess,
  strategies,
  unrecordedShareMints,
}: {
  environment: SdpEnvironment;
  onDeposit: (strategy: EarnStrategy) => void;
  positions: readonly EarnVaultPosition[] | undefined;
  providerAccess: EarnProviderAccess | null;
  strategies: readonly EarnStrategy[];
  unrecordedShareMints: ReadonlySet<string> | undefined;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [apySortDirection, setApySortDirection] = useState<NumericSortDirection>("descending");
  const sortedStrategies = useMemo(
    () => sortByOptionalDecimal(strategies, (strategy) => strategy.currentApy, apySortDirection),
    [apySortDirection, strategies]
  );

  return (
    <div className="overflow-x-auto">
      <Table
        className="!rounded-none !border-0 [&_table]:table-fixed"
        style={{ minWidth: "56rem" }}
      >
        <TableHeader>
          <TableRow>
            <TableHead className="w-[26%]">{t("DashboardMarkets.treasury.position")}</TableHead>
            <TableHead className="w-[14%]">{t("DashboardMarkets.treasury.asset")}</TableHead>
            <TableHead className="w-[16%]">{t("DashboardMarkets.treasury.yourPosition")}</TableHead>
            <SortableNumericTableHead
              className="w-[12%]"
              direction={apySortDirection}
              onToggle={() =>
                setApySortDirection((current) =>
                  current === "descending" ? "ascending" : "descending"
                )
              }
            >
              {t("DashboardMarkets.treasury.apy")}
            </SortableNumericTableHead>
            <TableHead className="w-[18%]">{t("DashboardMarkets.treasury.status")}</TableHead>
            <TableHead align="right" className="w-[14%]">
              {t("DashboardMarkets.treasury.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedStrategies.map((strategy) => {
            const asset = earnStrategyAsset(strategy);
            const position = positions
              ? strategyPositionValue(strategy, positions, unrecordedShareMints)
              : null;
            const availability = earnVaultDepositAvailability(
              strategy,
              environment,
              providerAccess
            );
            const canDeposit = availability === "available";
            const provider = earnProviderLabel(strategy.provider);
            const statusLabel =
              availability === "cluster_unavailable"
                ? t(TREASURY_AVAILABILITY_LABELS.cluster_unavailable, {
                    cluster: SOLANA_CLUSTER_LABELS[strategy.hostCluster],
                  })
                : t(TREASURY_AVAILABILITY_LABELS[availability]);
            return (
              <TableRow key={strategy.id}>
                <TableCell>
                  <TreasuryPositionIdentity name={strategy.name} provider={provider} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 text-sm text-secondary">
                    {asset ? <TokenMark mint={asset.mint} size="sm" symbol={asset.symbol} /> : null}
                    {asset?.symbol ?? "—"}
                  </div>
                </TableCell>
                <TableCell>
                  <p className="text-sm text-primary tabular-nums">
                    {position === null || position.unrecorded
                      ? "—"
                      : position.count === 0
                        ? "\u2014"
                        : formatProviderAmount(position.value, locale)}
                  </p>
                  {position === null ||
                  position.unrecorded ||
                  (position.count > 0 && position.value === undefined) ? (
                    <p className="mt-1 text-xs text-tertiary">
                      {t("DashboardMarkets.treasury.positionValueUnavailable")}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm text-primary tabular-nums">
                  {formatProviderApy(strategy.currentApy, locale)}
                </TableCell>
                <TableCell className="text-sm text-secondary">
                  <span className="block truncate" title={statusLabel}>
                    {statusLabel}
                  </span>
                </TableCell>
                <TableCell align="right">
                  <div className="flex justify-end gap-2">
                    <Button
                      disabled={!canDeposit}
                      iconLeft={<ArrowDownLeftIcon />}
                      onClick={() => onDeposit(strategy)}
                      size="sm"
                      type="button"
                    >
                      {t("DashboardMarkets.treasury.deposit")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function ActiveVaultPositionsCard({
  deposits,
  error,
  isLoading,
  onWithdraw,
  positions,
  unrecordedShareMints,
  wallets,
  withdrawals,
}: {
  deposits: readonly TrackedVaultDeposit[];
  error: unknown;
  isLoading: boolean;
  onWithdraw: (position: EarnVaultPosition) => void;
  positions: readonly EarnVaultPosition[] | undefined;
  unrecordedShareMints: ReadonlySet<string> | undefined;
  wallets: readonly EarnFundingWallet[];
  withdrawals: readonly TrackedVaultWithdrawal[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [balanceSortDirection, setBalanceSortDirection] =
    useState<NumericSortDirection>("descending");
  const activePositions = useMemo(
    () =>
      sortByOptionalDecimal(
        (positions ?? []).filter(isOpenVaultPosition),
        (position) => position.tokenValue,
        balanceSortDirection
      ),
    [balanceSortDirection, positions]
  );
  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet] as const));
  const latestActivityByPositionId = new Map<string, TrackedVaultActivity>();
  const rememberLatest = (activity: TrackedVaultActivity) => {
    const current = latestActivityByPositionId.get(activity.movement.positionId);
    const activityCreatedAt = activity.movement.createdAt;
    const currentCreatedAt = current?.movement.createdAt;
    // Server timestamps are authoritative when both movements have one. Until
    // a just-submitted deposit's detail read supplies its timestamp, compare
    // the order in which this client observed the movements. This avoids both
    // browser clock skew and a timestamp-less deposit masking a later exit.
    const isNewer =
      current === undefined ||
      (activityCreatedAt !== undefined && currentCreatedAt !== undefined
        ? activityCreatedAt > currentCreatedAt ||
          (activityCreatedAt === currentCreatedAt &&
            activity.movement.observedOrder > current.movement.observedOrder)
        : activity.movement.observedOrder > current.movement.observedOrder);
    if (isNewer) {
      latestActivityByPositionId.set(activity.movement.positionId, activity);
    }
  };
  for (const deposit of deposits) rememberLatest({ kind: "deposit", movement: deposit });
  for (const withdrawal of withdrawals) {
    rememberLatest({ kind: "withdrawal", movement: withdrawal });
  }

  return (
    <section>
      <h2 className="mb-4 text-[19px] leading-6 font-medium text-primary">
        {t("DashboardMarkets.treasury.vaultPositionsTitle")}
      </h2>
      <Card className="overflow-hidden rounded-2xl py-0">
        {isLoading ? (
          <div className="grid gap-3 px-6 py-5">
            <SkeletonBlock className="h-14 rounded-xl" />
            <SkeletonBlock className="h-14 rounded-xl" />
          </div>
        ) : error ? (
          <ListEmptyState
            description={t("DashboardMarkets.treasury.vaultPositionsErrorDescription")}
            icon={<InfoIcon aria-hidden="true" className="size-5" />}
            message={t("DashboardMarkets.treasury.vaultPositionsErrorTitle")}
          />
        ) : activePositions.length === 0 ? (
          // "No positions" is a claim of ABSENCE, so it needs the same witness
          // every other surface needs. Receipt tokens with no row behind them,
          // or a witness that could not be built, mean holdings may exist that
          // this list cannot show.
          unrecordedShareMints === undefined || unrecordedShareMints.size > 0 ? (
            <ListEmptyState
              description={t("DashboardMarkets.treasury.vaultPositionsIncompleteDescription")}
              icon={<InfoIcon aria-hidden="true" className="size-5" />}
              message={t("DashboardMarkets.treasury.vaultPositionsIncompleteTitle")}
            />
          ) : (
            <ListEmptyState
              description={t("DashboardMarkets.treasury.vaultPositionsEmptyDescription")}
              icon={<WalletCardsIcon aria-hidden="true" className="size-5" />}
              message={t("DashboardMarkets.treasury.vaultPositionsEmptyTitle")}
            />
          )
        ) : (
          <div className="overflow-x-auto">
            <Table
              className="!rounded-none !border-0 [&_table]:table-fixed"
              style={{ minWidth: "52rem" }}
            >
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[24%]">
                    {t("DashboardMarkets.treasury.position")}
                  </TableHead>
                  <TableHead className="w-[12%]">{t("DashboardMarkets.treasury.asset")}</TableHead>
                  <SortableNumericTableHead
                    className="w-[14%]"
                    direction={balanceSortDirection}
                    onToggle={() =>
                      setBalanceSortDirection((current) =>
                        current === "descending" ? "ascending" : "descending"
                      )
                    }
                  >
                    {t("DashboardMarkets.treasury.balance")}
                  </SortableNumericTableHead>
                  <TableHead className="w-[22%]">
                    {t("DashboardMarkets.treasury.custodyWallet")}
                  </TableHead>
                  <TableHead className="w-[15%]">
                    <span className="inline-flex items-center gap-1">
                      {t("DashboardMarkets.treasury.positionStatus")}
                      <TreasuryInfoTip
                        label={t("DashboardMarkets.treasury.positionStatusDescription")}
                      />
                    </span>
                  </TableHead>
                  <TableHead align="right" className="w-[13%]">
                    {t("DashboardMarkets.treasury.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activePositions.map((position) => {
                  const asset = earnMintAsset(position.tokenMint);
                  const wallet = walletById.get(position.custodyWalletId);
                  return (
                    <TableRow key={position.id}>
                      <TableCell>
                        <TreasuryPositionIdentity
                          name={position.label || shortenMarketAddress(position.providerReference)}
                          provider={earnProviderLabel(position.provider)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-sm text-secondary">
                          <TokenMark mint={asset.mint} size="sm" symbol={asset.symbol} />
                          {asset.symbol}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-primary tabular-nums">
                        {formatProviderAmount(position.tokenValue, locale)}
                      </TableCell>
                      <TableCell className="text-sm text-secondary">
                        {wallet?.label?.trim() ||
                          shortenMarketAddress(wallet?.publicKey ?? position.custodyWalletId)}
                      </TableCell>
                      <TableCell>
                        <TreasuryPositionStatusBadge
                          activity={latestActivityByPositionId.get(position.id)}
                        />
                      </TableCell>
                      <TableCell align="right">
                        {/*
                         * The exit route (PRO-1702). Deliberately NOT gated on
                         * availability, surfacing, or environment — money out
                         * beats money off (ADR 0002), so the verb stays live
                         * wherever a position exists. A provider whose exit
                         * SDP cannot build yet answers 501 with a clear error
                         * inside the modal rather than a silently dead button.
                         */}
                        <Button
                          data-earn-vault-withdraw-focus-fallback={position.id}
                          iconLeft={<ArrowUpRightIcon />}
                          onClick={() => onWithdraw(position)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {t("DashboardMarkets.treasury.withdraw")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </section>
  );
}

function programName(program: EarnProgram, fallback: string): string {
  const positionName = program.wallet.positions.find(
    (position) => position.kind === "yield_source"
  )?.label;
  return program.label?.trim() || positionName?.trim() || fallback;
}

function ExistingProgramsCard({
  programs,
  onWithdraw,
}: {
  programs: readonly EarnProgram[];
  onWithdraw: (program: EarnProgram) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (programs.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{t("DashboardMarkets.treasury.existingProgramsTitle")}</CardTitle>
        <CardDescription>
          {t("DashboardMarkets.treasury.existingProgramsDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto border-t border-border-subtle">
          <Table className="table-fixed" style={{ minWidth: "48rem" }}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[34%]">{t("DashboardMarkets.treasury.strategy")}</TableHead>
                <TableHead className="w-[18%]">{t("DashboardMarkets.treasury.provider")}</TableHead>
                <TableHead className="w-[18%]">{t("DashboardMarkets.treasury.balance")}</TableHead>
                <TableHead className="w-[16%]">{t("DashboardMarkets.treasury.status")}</TableHead>
                <TableHead align="right" className="w-[14%]">
                  {t("DashboardMarkets.treasury.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {programs.map((program) => {
                const withdrawalAvailable =
                  earnProgramSolanaPayoutTokens(program.provider).length > 0;
                return (
                  <TableRow key={program.id}>
                    <TableCell className="text-sm text-primary">
                      {programName(program, t("DashboardMarkets.treasury.unnamedProgram"))}
                    </TableCell>
                    <TableCell className="text-sm text-secondary">
                      <span className="block truncate" title={earnProviderLabel(program.provider)}>
                        {earnProviderLabel(program.provider)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-primary tabular-nums">
                      {formatProviderAmount(
                        program.wallet.balance.totalUsd,
                        locale,
                        t("DashboardMarkets.treasury.usdSymbol"),
                        2,
                        2
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={program.wallet.status === "failed" ? "danger" : "outline"}>
                        {program.wallet.status}
                      </Badge>
                    </TableCell>
                    <TableCell align="right">
                      <div className="flex flex-col items-end gap-1.5">
                        {/* An open provider id may outlive its runtime capability.
                            Never open a provider-specific withdrawal form unless
                            the shared contract declares a Solana payout lane. */}
                        <Button
                          data-earn-withdraw-focus-fallback={program.id}
                          disabled={program.wallet.status === "creating" || !withdrawalAvailable}
                          iconLeft={<ArrowUpRightIcon />}
                          onClick={() => onWithdraw(program)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {t("DashboardMarkets.treasury.withdraw")}
                        </Button>
                        {!withdrawalAvailable ? (
                          <span className="text-[11px] leading-4 text-tertiary">
                            {t("DashboardMarkets.treasury.providerWithdrawalUnavailable")}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-start gap-2 bg-fill-subtle px-6 py-3 text-xs leading-5 text-secondary">
          <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {/* Ground can require customer-side approval, but SDP has no
           * provider-approval route or signer UI yet. Never imply the
           * dashboard can release a withdrawal that is parked there. */}
          <p>{t("DashboardMarkets.treasury.withdrawalApprovalUnavailable")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

interface EarnWithdrawalWatch {
  programId: string;
  withdrawalRef: string;
}

function withdrawalWatchKey(watch: EarnWithdrawalWatch): string {
  return `${watch.programId}:${watch.withdrawalRef}`;
}

function TreasuryStrategiesCard({
  cluster,
  environment,
  error,
  isLoading,
  onClusterChange,
  onDeposit,
  onRefresh,
  positions,
  providerAccess,
  strategies,
  unrecordedShareMints,
}: {
  /** The cluster sub-shelf being browsed — the environment's own by default. */
  cluster: SolanaCluster;
  environment: SdpEnvironment;
  error: unknown;
  isLoading: boolean;
  onClusterChange: (cluster: SolanaCluster) => void;
  onDeposit: (strategy: EarnStrategy) => void;
  onRefresh: () => void;
  positions: readonly EarnVaultPosition[] | undefined;
  providerAccess: EarnProviderAccess | null;
  strategies: readonly EarnStrategy[] | undefined;
  unrecordedShareMints: ReadonlySet<string> | undefined;
}) {
  const t = useTranslations();
  const depositsEnabled = isVaultDirectDepositEnabled(environment);

  return (
    <section>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex items-center gap-1 text-[19px] leading-6 font-medium text-primary">
          {t("DashboardMarkets.treasury.strategiesTitle")}
          <TreasuryInfoTip
            label={t(
              providerAccess === null
                ? "DashboardMarkets.treasury.accessDisclosure"
                : depositsEnabled
                  ? "DashboardMarkets.treasury.rateDisclosure"
                  : "DashboardMarkets.treasury.productionDisclosure"
            )}
          />
        </h2>
        <div className="flex items-center gap-2">
          {environment === "sandbox" ? (
            // Sandbox only (PRO-1742): production has no other shelf to
            // offer, so the control must not render there at all — reviewing
            // the mainnet catalogue IS what production shows by default.
            <SegmentedControl
              aria-label={t("DashboardMarkets.treasury.clusterToggleLabel")}
              items={SOLANA_CLUSTERS.map((option) => ({
                value: option,
                label: SOLANA_CLUSTER_LABELS[option],
              }))}
              value={cluster}
              // Re-clicking the active segment can emit an empty value from
              // the underlying toggle group; a shelf always has a selection.
              onValueChange={(value) => value && onClusterChange(value as SolanaCluster)}
            />
          ) : null}
          <Button
            iconLeft={<RefreshCwIcon />}
            onClick={onRefresh}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("DashboardMarkets.treasury.refresh")}
          </Button>
        </div>
      </div>
      <Card className="overflow-hidden rounded-2xl py-0">
        {isLoading ? (
          <div className="grid gap-3 px-6 py-5">
            <SkeletonBlock className="h-14 rounded-xl" />
            <SkeletonBlock className="h-14 rounded-xl" />
            <SkeletonBlock className="h-14 rounded-xl" />
          </div>
        ) : error ? (
          <ListEmptyState
            description={t("DashboardMarkets.treasury.strategiesErrorDescription")}
            icon={<InfoIcon aria-hidden="true" className="size-5" />}
            message={t("DashboardMarkets.treasury.strategiesErrorTitle")}
          />
        ) : (strategies ?? []).length === 0 ? (
          <ListEmptyState
            description={t("DashboardMarkets.treasury.strategiesEmptyDescription")}
            icon={<InfoIcon aria-hidden="true" className="size-5" />}
            message={t("DashboardMarkets.treasury.strategiesEmptyTitle")}
          />
        ) : (
          <StrategyTable
            environment={environment}
            onDeposit={onDeposit}
            positions={positions}
            providerAccess={providerAccess}
            strategies={strategies ?? []}
            unrecordedShareMints={unrecordedShareMints}
          />
        )}
      </Card>
    </section>
  );
}

/**
 * Recover only provider-accepted withdrawals that can still change. A
 * `requested` ledger row has no accepted provider operation to poll, and a row
 * without a provider reference cannot name the live resource without inventing
 * one. Duplicate references collapse to one tracker.
 */
function recoverableWithdrawalWatches(
  programId: string,
  withdrawals: readonly EarnProgramWithdrawalRecord[]
): EarnWithdrawalWatch[] {
  const seen = new Set<string>();
  const watches: EarnWithdrawalWatch[] = [];
  for (const withdrawal of withdrawals) {
    if (withdrawal.status !== "processing" && withdrawal.status !== "pending_approval") continue;
    const withdrawalRef = withdrawal.withdrawalRef;
    if (!withdrawalRef || withdrawalRef.trim() === "" || seen.has(withdrawalRef)) continue;
    seen.add(withdrawalRef);
    watches.push({ programId, withdrawalRef });
  }
  return watches;
}

function EarnWithdrawalLedgerRecovery({
  onRecover,
  programId,
}: {
  onRecover: (watches: readonly EarnWithdrawalWatch[]) => void;
  programId: string;
}) {
  const { withdrawals } = useEarnProgramWithdrawals(programId);

  useEffect(() => {
    if (!withdrawals) return;
    const watches = recoverableWithdrawalWatches(programId, withdrawals);
    if (watches.length > 0) onRecover(watches);
  }, [onRecover, programId, withdrawals]);

  return null;
}

export function TreasurySolutionsWorkspace({
  providerAccess,
}: {
  providerAccess: EarnProviderAccess | null;
}) {
  const t = useTranslations();
  const { sdpEnvironment, selectedProjectId } = useDashboardWorkspace();
  const {
    wallets,
    error: walletsError,
    isLoading: walletsLoading,
    refresh: refreshWallets,
  } = useEarnFundingWallets();
  const {
    strategies,
    error: strategiesError,
    isLoading: strategiesLoading,
    refresh: refreshStrategies,
  } = useEarnStrategies();
  // PRO-1742: the strategies card's cluster opt-in, sandbox-only by
  // construction — production always reads its default shelf. The card's read
  // is SEPARATE from `strategies` above on purpose: that read doubles as the
  // share-mint vocabulary behind the allocation summary, and browsing the
  // mirrored mainnet shelf must not blank the devnet vocabulary under it. On
  // the default shelf both hooks share one SWR key, so no second fetch happens
  // until the toggle leaves it. `undefined` means "the default shelf", and the
  // toggle handler below normalizes the environment's own cluster back to it,
  // so toggling away and back re-joins the shared key instead of keeping a
  // second, permanently distinct cache entry of the identical shelf.
  const [catalogueCluster, setCatalogueCluster] = useState<SolanaCluster | undefined>(undefined);
  const strategiesCluster = sdpEnvironment === "sandbox" ? catalogueCluster : undefined;
  const environmentCluster = CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment];
  const {
    strategies: catalogueStrategies,
    error: catalogueError,
    isLoading: catalogueLoading,
    refresh: refreshCatalogue,
  } = useEarnStrategies({ cluster: strategiesCluster });
  const {
    positions,
    error: positionsError,
    isLoading: positionsLoading,
    refresh: refreshPositions,
  } = useEarnVaultPositions();
  const {
    state: programsState,
    error: programsError,
    isLoading: programsLoading,
    refresh: refreshPrograms,
  } = useEarnPrograms();
  const { deposits: discoveredVaultDeposits } = useEarnVaultDeposits();
  const { withdrawals: discoveredVaultWithdrawals } = useEarnVaultWithdrawals();
  const [depositStrategy, setDepositStrategy] = useState<EarnStrategy | null>(null);
  const [withdrawProgram, setWithdrawProgram] = useState<EarnProgram | null>(null);
  const [withdrawPosition, setWithdrawPosition] = useState<EarnVaultPosition | null>(null);
  const [withdrawalWatches, setWithdrawalWatches] = useState<readonly EarnWithdrawalWatch[]>([]);
  const settledWithdrawalKeys = useRef(new Set<string>());
  const vaultActivityOrder = useRef(0);
  const [vaultDepositWatches, setVaultDepositWatches] = useState<readonly TrackedVaultDeposit[]>(
    []
  );
  const [settledVaultDepositIds, setSettledVaultDepositIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [vaultWithdrawalWatches, setVaultWithdrawalWatches] = useState<
    readonly TrackedVaultWithdrawal[]
  >([]);
  const [settledVaultWithdrawalIds, setSettledVaultWithdrawalIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  // Pure updater: the recovery list re-asserts every 30s, so this runs often
  // and must not have side effects (StrictMode double-invokes it in dev).
  const addVaultDepositWatches = useCallback(
    (incoming: readonly VaultDepositWatchInput[]) => {
      const observedIncoming = [...incoming].reverse().map((deposit) => ({
        ...deposit,
        observedOrder: ++vaultActivityOrder.current,
      }));
      setVaultDepositWatches((current) => {
        const next = [...current];
        // The collection is newest-first. Reverse it before appending so the
        // latest observed deposit for a position stays last and wins the
        // status column's map reduction.
        for (const deposit of observedIncoming) {
          const existingIndex = next.findIndex(
            (candidate) => candidate.movementId === deposit.movementId
          );
          // `settledVaultDepositIds` is load-bearing, not defensive: the ledger
          // list keeps re-asserting a row until the server marks it terminal, so
          // without a tombstone a settled deposit would resume polling.
          if (settledVaultDepositIds.has(deposit.movementId)) continue;
          if (existingIndex >= 0) {
            next[existingIndex] = {
              ...deposit,
              observedOrder: next[existingIndex]?.observedOrder ?? deposit.observedOrder,
            };
          } else {
            next.push(deposit);
          }
        }
        return next.slice(-MAX_VISIBLE_VAULT_ACTIVITY);
      });
    },
    [settledVaultDepositIds]
  );

  // Same pure-updater and tombstone rules as the deposit watches above.
  const addVaultWithdrawalWatches = useCallback(
    (incoming: readonly VaultWithdrawalWatchInput[]) => {
      const observedIncoming = [...incoming].reverse().map((withdrawal) => ({
        ...withdrawal,
        observedOrder: ++vaultActivityOrder.current,
      }));
      setVaultWithdrawalWatches((current) => {
        const next = [...current];
        for (const withdrawal of observedIncoming) {
          const existingIndex = next.findIndex(
            (candidate) => candidate.movementId === withdrawal.movementId
          );
          if (settledVaultWithdrawalIds.has(withdrawal.movementId)) continue;
          if (existingIndex >= 0) {
            next[existingIndex] = {
              ...withdrawal,
              observedOrder: next[existingIndex]?.observedOrder ?? withdrawal.observedOrder,
            };
          } else {
            next.push(withdrawal);
          }
        }
        return next.slice(-MAX_VISIBLE_VAULT_ACTIVITY);
      });
    },
    [settledVaultWithdrawalIds]
  );

  const addWithdrawalWatches = useCallback((incoming: readonly EarnWithdrawalWatch[]) => {
    setWithdrawalWatches((current) => {
      const known = new Set(current.map(withdrawalWatchKey));
      const additions = incoming.filter((watch) => {
        const key = withdrawalWatchKey(watch);
        if (known.has(key) || settledWithdrawalKeys.current.has(key)) return false;
        known.add(key);
        return true;
      });
      return additions.length === 0 ? current : [...current, ...additions];
    });
  }, []);

  const activeWallets = wallets ?? [];
  // Every share mint the page knows about, from positions AND the catalogue:
  // a wallet can hold receipt tokens for a strategy it has no recorded
  // position in (deposited outside SDP), and those tiles are still not cash.
  // A USD-stable mint can never be a share mint; a corrupt catalogue row
  // claiming one must not hide real cash tiles the summary still counts.
  //
  // The known set stays best-effort in every state, because hiding a receipt
  // tile only needs the mint to be known. `complete` is the stricter claim,
  // and it needs three things:
  //   - the catalogue landed at all (it is the only witness for a holding with
  //     no position row),
  //   - the read is not stale behind a failed revalidation, which would be
  //     missing any strategy added since (the strategy table already renders
  //     its error state over stale rows, so this matches that posture), and
  //   - every row actually NAMED its share mint, since a row without one
  //     contributes nothing and leaves a real vault unnameable.
  const shareMints = {
    known: new Set(
      [
        ...(positions ?? []).map((position) => position.shareMint),
        ...(strategies ?? []).flatMap((strategy) => strategy.shareMint ?? []),
      ].filter((mint) => !WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.isUsdStable)
    ),
    complete:
      strategies !== undefined &&
      !strategiesError &&
      strategies.every((strategy) => strategy.shareMint !== undefined),
  };
  // Every figure on this page comes from here, so no two surfaces can compute
  // the same thing differently.
  const allocation = summarizeTreasuryAllocation({
    positions: positionsError ? undefined : positions,
    shareMints,
    wallets: walletsError ? undefined : wallets,
  });
  const programs = programsState?.kind === "ready" ? programsState.programs : [];
  // Recovery seeds durable component state. Do not derive tracker mounts
  // directly from the live list: the list can stop returning a movement just
  // before its detail poll observes terminal state, which would unmount the
  // tracker and skip `onSettled` balance refreshes and the final table status.
  useEffect(() => {
    addVaultDepositWatches((discoveredVaultDeposits ?? []).filter(isEarnVaultDepositInFlight));
  }, [addVaultDepositWatches, discoveredVaultDeposits]);
  useEffect(() => {
    addVaultWithdrawalWatches(
      (discoveredVaultWithdrawals ?? []).filter(isEarnVaultWithdrawalInFlight)
    );
  }, [addVaultWithdrawalWatches, discoveredVaultWithdrawals]);

  const activeVaultDepositWatches = vaultDepositWatches.filter(
    (deposit) => !settledVaultDepositIds.has(deposit.movementId)
  );
  const activeVaultWithdrawalWatches = vaultWithdrawalWatches.filter(
    (withdrawal) => !settledVaultWithdrawalIds.has(withdrawal.movementId)
  );
  const portfolioApy =
    allocation.deployedValue === undefined || positionsError || strategiesError
      ? undefined
      : estimatedTreasuryApy({ positions, strategies });

  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-8 pb-12 md:px-8 xl:px-9">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-16">
        {/* Errors pass undefined so a stale SWR success never renders as a
         * live figure: unavailable must read as unavailable, not as the last
         * total that happened to load. */}
        {/* The strategies read gates the skeleton too: it is the share-mint
         * vocabulary, it pages sequentially so it usually lands last, and
         * without it the summary can only report "unavailable". */}
        <TreasuryAllocationCard
          allocation={allocation}
          estimatedApy={portfolioApy}
          isLoading={
            !(walletsError || positionsError || strategiesError) &&
            (walletsLoading || positionsLoading || strategiesLoading)
          }
        />

        <TreasuryWalletsCard
          allocation={allocation}
          error={walletsError}
          isLoading={walletsLoading}
          wallets={activeWallets}
        />

        <ActiveVaultPositionsCard
          deposits={vaultDepositWatches}
          error={positionsError}
          isLoading={positionsLoading}
          onWithdraw={setWithdrawPosition}
          positions={positionsError ? undefined : positions}
          unrecordedShareMints={allocation.unrecordedShareMints}
          wallets={activeWallets}
          withdrawals={vaultWithdrawalWatches}
        />

        <TreasuryStrategiesCard
          cluster={strategiesCluster ?? environmentCluster}
          environment={sdpEnvironment}
          error={catalogueError}
          // keepPreviousData holds the outgoing shelf's rows through a toggle
          // flip, so skeletons are for the true first load only.
          isLoading={catalogueLoading && catalogueStrategies === undefined}
          onClusterChange={(cluster) =>
            setCatalogueCluster(cluster === environmentCluster ? undefined : cluster)
          }
          onDeposit={setDepositStrategy}
          onRefresh={() => {
            refreshWallets();
            refreshStrategies();
            // On the default shelf both strategy hooks share one SWR key, and
            // refreshing it twice would run the paged catalogue fetch twice
            // per click; the mirror shelf only needs its own refresh once the
            // toggle has left the default.
            if (strategiesCluster !== undefined) {
              refreshCatalogue();
            }
            refreshPositions();
            refreshPrograms();
          }}
          positions={positionsError ? undefined : positions}
          providerAccess={providerAccess}
          strategies={catalogueStrategies}
          unrecordedShareMints={allocation.unrecordedShareMints}
        />

        {programsLoading ? <SkeletonBlock className="h-48 rounded-xl" /> : null}
        {programsError || programsState?.kind === "unconfigured" ? (
          <Card className="px-6 py-5">
            <p className="text-sm text-secondary">
              {t("DashboardMarkets.treasury.existingProgramsUnavailable")}
            </p>
          </Card>
        ) : (
          <ExistingProgramsCard programs={programs} onWithdraw={setWithdrawProgram} />
        )}
      </div>

      {depositStrategy ? (
        <EarnVaultDepositModal
          onClose={() => setDepositStrategy(null)}
          projectId={selectedProjectId}
          onDeposited={(deposit) => {
            // Two refreshes, for two different moments. This one shows the
            // claimed position row and the debited wallet right away; the
            // watch below is what re-reads them once the chain has actually
            // decided, which is the only point at which the holding is real.
            addVaultDepositWatches([deposit]);
            refreshPositions();
            refreshWallets();
          }}
          strategy={depositStrategy}
        />
      ) : null}

      {withdrawProgram ? (
        <EarnWithdrawModal
          onClose={() => setWithdrawProgram(null)}
          onWithdrawalCreated={(withdrawalRef) => {
            addWithdrawalWatches([{ programId: withdrawProgram.id, withdrawalRef }]);
            refreshPrograms();
          }}
          provider={withdrawProgram.provider}
          programId={withdrawProgram.id}
        />
      ) : null}

      {withdrawPosition ? (
        <EarnVaultWithdrawModal
          environment={sdpEnvironment}
          onClose={() => setWithdrawPosition(null)}
          onWithdrawn={(withdrawal) => {
            addVaultWithdrawalWatches([withdrawal]);
            refreshPositions();
            refreshWallets();
          }}
          position={withdrawPosition}
          projectId={selectedProjectId}
        />
      ) : null}

      {programs.map((program) => (
        <EarnWithdrawalLedgerRecovery
          key={`withdrawal-ledger:${program.id}`}
          onRecover={addWithdrawalWatches}
          programId={program.id}
        />
      ))}

      {activeVaultWithdrawalWatches.map((withdrawal) => (
        <EarnVaultWithdrawalOutcomeTracker
          key={`vault-withdrawal:${withdrawal.movementId}`}
          movementId={withdrawal.movementId}
          onUpdated={(updatedWithdrawal) => {
            setVaultWithdrawalWatches((current) =>
              replaceTrackedVaultMovement(current, updatedWithdrawal)
            );
          }}
          onSettled={(settledWithdrawal) => {
            setVaultWithdrawalWatches((current) =>
              replaceTrackedVaultMovement(current, settledWithdrawal)
            );
            setSettledVaultWithdrawalIds((current) =>
              new Set(current).add(settledWithdrawal.movementId)
            );
            // Only now did the exit change what the org holds: the shares are
            // burned and the proceeds sit in the custody wallet.
            refreshPositions();
            refreshWallets();
          }}
        />
      ))}

      {activeVaultDepositWatches.map((deposit) => (
        <EarnVaultDepositOutcomeTracker
          key={`vault-deposit:${deposit.movementId}`}
          movementId={deposit.movementId}
          onUpdated={(updatedDeposit) => {
            setVaultDepositWatches((current) =>
              replaceTrackedVaultMovement(current, updatedDeposit)
            );
          }}
          onSettled={(settledDeposit) => {
            setVaultDepositWatches((current) =>
              replaceTrackedVaultMovement(current, settledDeposit)
            );
            setSettledVaultDepositIds((current) => new Set(current).add(settledDeposit.movementId));
            // Only NOW is the position real: the shares exist on chain and the
            // wallet balance reflects what left it.
            refreshPositions();
            refreshWallets();
          }}
        />
      ))}

      {withdrawalWatches.map((watch) => (
        <EarnWithdrawalOutcomeTracker
          onSettled={() => {
            settledWithdrawalKeys.current.add(withdrawalWatchKey(watch));
            refreshPrograms();
            setWithdrawalWatches((current) =>
              current.filter(
                (candidate) =>
                  candidate.programId !== watch.programId ||
                  candidate.withdrawalRef !== watch.withdrawalRef
              )
            );
          }}
          key={withdrawalWatchKey(watch)}
          programId={watch.programId}
          withdrawalRef={watch.withdrawalRef}
        />
      ))}
    </DashboardWorkspaceOverviewPanel>
  );
}
