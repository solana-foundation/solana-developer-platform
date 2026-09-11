"use client";

import { decimalScale, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import {
  type EarnProgramWithdrawalRecord,
  type EarnStrategy,
  type EarnVaultPosition,
  type EarnVaultWithdrawal,
  earnProgramSolanaPayoutTokens,
  isVaultDirectDepositEnabled,
  type SdpEnvironment,
  SOLANA_CLUSTER_LABELS,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import {
  ArrowDownIcon,
  ArrowDownLeftIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  InfoIcon,
  RefreshCwIcon,
  WalletCardsIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
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
import {
  useDashboardWorkspace,
  useOptionalDashboardWorkspace,
} from "@/contexts/dashboard-workspace-context";
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
  EarnDepositAvailabilityBadge,
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
  SURFACED_VAULT_DIRECT_EARN_PROVIDERS,
} from "../earn/earn-surfacing";
import {
  EarnVaultDepositModal,
  EarnVaultDepositOutcomeTracker,
} from "../earn/earn-vault-deposit-modal";
import {
  earnVaultDepositUiState,
  earnVaultPositionStatusDisplay,
  earnVaultWithdrawalUiState,
} from "../earn/earn-vault-ui-state";
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
  type VaultShareMintVocabulary,
} from "./treasury-allocation";

interface VaultBalanceProjection {
  amount: string;
  baselineValue: string;
  expiresAt: number;
  projectedValue: string;
}

type TrackedVaultDeposit = Pick<
  EarnVaultDepositRecord,
  "failureReason" | "movementId" | "positionId" | "status"
> & {
  balanceProjection?: VaultBalanceProjection;
  createdAt?: string;
  observedOrder: number;
  provisionalPosition?: EarnVaultPosition;
};

type VaultDepositWatchInput = Omit<TrackedVaultDeposit, "observedOrder">;

type TrackedVaultWithdrawal = Pick<
  EarnVaultWithdrawal,
  "createdAt" | "failureReason" | "movementId" | "positionId" | "status"
> & { balanceProjection?: VaultBalanceProjection; observedOrder: number };

type VaultWithdrawalWatchInput = Omit<TrackedVaultWithdrawal, "observedOrder">;

type TrackedVaultActivity =
  | { kind: "deposit"; movement: TrackedVaultDeposit }
  | { kind: "withdrawal"; movement: TrackedVaultWithdrawal };

const MAX_VISIBLE_VAULT_ACTIVITY = 50;
const VAULT_BALANCE_PROJECTION_TTL_MS = 60_000;

const TREASURY_AVAILABILITY_LABELS = {
  available: "DashboardMarkets.treasury.depositAvailable",
  cluster_unavailable: "DashboardMarkets.treasury.clusterUnavailable",
  strategy_unavailable: "DashboardMarkets.treasury.depositUnavailable",
  environment_unavailable: "DashboardMarkets.treasury.productionUnavailable",
  access_unavailable: "DashboardMarkets.treasury.accessUnavailable",
  provider_unavailable: "DashboardMarkets.treasury.providerUnavailable",
} as const satisfies Readonly<Record<EarnVaultDepositAvailability, MessageKey>>;

type NumericSortDirection = "ascending" | "descending";
type NumericSortState = NumericSortDirection | "none";
type StrategySortField = "apy" | "tvl";

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
  direction: NumericSortState;
  onToggle: () => void;
}) {
  const SortIcon =
    direction === "ascending"
      ? ArrowUpIcon
      : direction === "descending"
        ? ArrowDownIcon
        : ArrowUpDownIcon;

  return (
    <TableHead aria-sort={direction} className={className}>
      <button
        className="-ml-1 inline-flex items-center gap-2 rounded-md px-1 py-1 text-left text-inherit transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
        onClick={onToggle}
        type="button"
      >
        <SortIcon
          aria-hidden="true"
          className={`size-4 shrink-0 ${direction === "none" ? "text-tertiary" : "text-secondary"}`}
        />
        <span>{children}</span>
      </button>
    </TableHead>
  );
}

function strategyTvlUsd(strategy: EarnStrategy): string | undefined {
  const tvl = strategy.riskMetadata?.tvlUsd;
  return typeof tvl === "number" && Number.isFinite(tvl) && tvl >= 0 ? String(tvl) : undefined;
}

function replaceTrackedVaultMovement<
  Movement extends { movementId: string },
  Update extends { movementId: string },
>(current: readonly Movement[], updated: Update): readonly Movement[] {
  return current.map((candidate) =>
    candidate.movementId === updated.movementId ? { ...candidate, ...updated } : candidate
  );
}

function subtractUnsignedDecimalStrings(left: string, right: string): string | undefined {
  if (
    compareUnsignedDecimals(left, "0") === undefined ||
    compareUnsignedDecimals(right, "0") === undefined
  ) {
    return undefined;
  }
  const scale = Math.max(decimalScale(left), decimalScale(right));
  const difference = parseDecimalAmount(left, scale) - parseDecimalAmount(right, scale);
  return formatDecimalAmount(difference > 0n ? difference : 0n, scale);
}

function projectedVaultBalance(
  baselineValue: string,
  amount: string,
  kind: TrackedVaultActivity["kind"]
): string | undefined {
  return kind === "deposit"
    ? sumDecimalStrings([baselineValue, amount])
    : subtractUnsignedDecimalStrings(baselineValue, amount);
}

function createVaultBalanceProjection(
  baselineValue: string | undefined,
  amount: string,
  kind: TrackedVaultActivity["kind"]
): VaultBalanceProjection | undefined {
  if (baselineValue === undefined) return undefined;
  const projectedValue = projectedVaultBalance(baselineValue, amount, kind);
  if (projectedValue === undefined) return undefined;
  return {
    amount,
    baselineValue,
    expiresAt: Date.now() + VAULT_BALANCE_PROJECTION_TTL_MS,
    projectedValue,
  };
}

function vaultBalanceProjectionIsVisible(activity: TrackedVaultActivity): boolean {
  return activity.kind === "deposit"
    ? activity.movement.status === "confirmed"
    : activity.movement.status === "finalized";
}

function balanceProjectionReachedProvider(
  projection: VaultBalanceProjection,
  kind: TrackedVaultActivity["kind"],
  position: EarnVaultPosition | undefined
): boolean {
  if (!position) return kind === "withdrawal";
  if (position.tokenValue === undefined) return false;
  const comparison = compareUnsignedDecimals(position.tokenValue, projection.projectedValue);
  if (comparison === undefined) return false;
  return kind === "deposit" ? comparison >= 0 : comparison <= 0;
}

function latestVaultActivityByPosition(
  deposits: readonly TrackedVaultDeposit[],
  withdrawals: readonly TrackedVaultWithdrawal[]
): Map<string, TrackedVaultActivity> {
  const latestActivityByPositionId = new Map<string, TrackedVaultActivity>();
  const rememberLatest = (activity: TrackedVaultActivity) => {
    const current = latestActivityByPositionId.get(activity.movement.positionId);
    const activityCreatedAt = activity.movement.createdAt;
    const currentCreatedAt = current?.movement.createdAt;
    const isNewer =
      current === undefined ||
      (activityCreatedAt !== undefined && currentCreatedAt !== undefined
        ? activityCreatedAt > currentCreatedAt ||
          (activityCreatedAt === currentCreatedAt &&
            activity.movement.observedOrder > current.movement.observedOrder)
        : activity.movement.observedOrder > current.movement.observedOrder);
    if (isNewer) latestActivityByPositionId.set(activity.movement.positionId, activity);
  };
  for (const deposit of deposits) rememberLatest({ kind: "deposit", movement: deposit });
  for (const withdrawal of withdrawals) {
    rememberLatest({ kind: "withdrawal", movement: withdrawal });
  }
  return latestActivityByPositionId;
}

function vaultProjectionActivities(
  positionId: string,
  position: EarnVaultPosition | undefined,
  deposits: readonly TrackedVaultDeposit[],
  withdrawals: readonly TrackedVaultWithdrawal[],
  includePending: boolean
): TrackedVaultActivity[] {
  const activities: TrackedVaultActivity[] = [
    ...deposits.map((movement) => ({ kind: "deposit" as const, movement })),
    ...withdrawals.map((movement) => ({ kind: "withdrawal" as const, movement })),
  ];
  return activities
    .filter((activity) => {
      if (activity.movement.positionId !== positionId) return false;
      const projection = activity.movement.balanceProjection;
      if (
        !projection ||
        projection.expiresAt <= Date.now() ||
        activity.movement.status === "failed" ||
        (!includePending && !vaultBalanceProjectionIsVisible(activity))
      ) {
        return false;
      }
      return !balanceProjectionReachedProvider(projection, activity.kind, position);
    })
    .sort((left, right) => left.movement.observedOrder - right.movement.observedOrder);
}

function balanceFromProjectionActivities(
  position: EarnVaultPosition | undefined,
  activities: readonly TrackedVaultActivity[]
): string | undefined {
  if (activities.length === 0) return position?.tokenValue;
  let balance = position?.tokenValue ?? activities[0]?.movement.balanceProjection?.baselineValue;
  if (balance === undefined) return undefined;
  for (const activity of activities) {
    const amount = activity.movement.balanceProjection?.amount;
    if (amount === undefined) continue;
    const nextBalance = projectedVaultBalance(balance, amount, activity.kind);
    if (nextBalance === undefined) return undefined;
    balance = nextBalance;
  }
  return balance;
}

function visibleProjectedVaultBalance(
  position: EarnVaultPosition,
  deposits: readonly TrackedVaultDeposit[],
  withdrawals: readonly TrackedVaultWithdrawal[]
): string | undefined {
  const activities = vaultProjectionActivities(position.id, position, deposits, withdrawals, false);
  return activities.length > 0 ? balanceFromProjectionActivities(position, activities) : undefined;
}

function provisionalVaultPosition(
  deposit: Pick<EarnVaultDepositRecord, "positionId"> & { createdAt?: string },
  custodyWalletId: string,
  strategy: EarnStrategy
): EarnVaultPosition | undefined {
  const shareMint = strategy.shareMint;
  const tokenMint = strategy.depositMints[0];
  if (!shareMint || !tokenMint) return undefined;
  return {
    id: deposit.positionId,
    provider: strategy.provider,
    providerReference: strategy.providerReference,
    label: strategy.name,
    custodyWalletId,
    tokenMint,
    shareMint,
    createdAt: deposit.createdAt ?? new Date().toISOString(),
    closedAt: null,
    feeSponsored: strategy.feeSponsored,
  };
}

function displayedVaultPositions(
  positions: readonly EarnVaultPosition[] | undefined,
  deposits: readonly TrackedVaultDeposit[]
): EarnVaultPosition[] {
  const displayed = [...(positions ?? [])];
  const authoritativeIds = new Set(displayed.map(({ id }) => id));
  for (const deposit of deposits) {
    const provisional = deposit.provisionalPosition;
    if (deposit.status === "failed" || !provisional || authoritativeIds.has(provisional.id))
      continue;
    displayed.push(provisional);
    authoritativeIds.add(provisional.id);
  }
  return displayed;
}

function currentVaultBalance(
  positionId: string,
  positions: readonly EarnVaultPosition[] | undefined,
  deposits: readonly TrackedVaultDeposit[],
  withdrawals: readonly TrackedVaultWithdrawal[]
): string | undefined {
  const position = positions?.find((candidate) => candidate.id === positionId);
  return balanceFromProjectionActivities(
    position,
    vaultProjectionActivities(positionId, position, deposits, withdrawals, true)
  );
}

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
  const positionStatus = activity
    ? (activity.kind === "deposit"
        ? earnVaultDepositUiState(activity.movement.status)
        : earnVaultWithdrawalUiState(activity.movement.status)
      ).positionStatus
    : "active";
  const display = earnVaultPositionStatusDisplay(
    positionStatus,
    t("DashboardMarkets.treasury.positionStatusPending"),
    t("DashboardMarkets.treasury.positionStatusActive")
  );
  const description =
    positionStatus === "pending"
      ? t("DashboardMarkets.treasury.positionStatusPendingDescription")
      : t("DashboardMarkets.treasury.positionStatusActiveDescription");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={`${display.label}: ${description}`}
            className="inline-flex cursor-help border-0 bg-transparent p-0"
            type="button"
          >
            <Badge variant={display.variant}>{display.label}</Badge>
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
  const workspace = useOptionalDashboardWorkspace();
  const custodyEnabled = workspace?.flags.custody ?? true;
  const canManageCustody = workspace?.dashboardAccess.capabilities.canManageCustody ?? true;
  if (!custodyEnabled) return null;
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-[19px] leading-6 font-medium text-primary">
          {t("DashboardMarkets.treasury.connectedWallets")}
        </h2>
        {wallets.length > 0 ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={DASHBOARD_SIDE_NAV_HREFS.wallets}>
              {t("DashboardMarkets.treasury.viewAll")}
            </Link>
          </Button>
        ) : null}
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
        <Card className="overflow-hidden rounded-2xl py-0">
          <ListEmptyState
            action={
              canManageCustody ? (
                <Button asChild size="sm">
                  <Link href={`${DASHBOARD_SIDE_NAV_HREFS.wallets}/setup`}>
                    {t("DashboardCustody.createWallet")}
                  </Link>
                </Button>
              ) : undefined
            }
            description={t("DashboardMarkets.treasury.walletsEmptyDescription")}
            icon={<WalletCardsIcon aria-hidden="true" className="size-5" />}
            message={t("DashboardMarkets.treasury.walletsEmptyTitle")}
          />
        </Card>
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

function TreasuryPositionIdentity({
  cluster,
  name,
  provider,
}: {
  cluster?: EarnStrategy["hostCluster"];
  name: string;
  provider: string;
}) {
  return (
    <div className="min-w-0">
      <p className="flex min-w-0 items-center gap-2 text-sm text-primary">
        <span className="truncate" title={name}>
          {name}
        </span>
        {cluster === "devnet" ? (
          <Badge className="shrink-0 text-[10px]" variant="outline">
            {SOLANA_CLUSTER_LABELS[cluster]}
          </Badge>
        ) : null}
      </p>
      <p className="mt-0.5 truncate text-xs text-tertiary">{provider}</p>
    </div>
  );
}

function strategyNetworkRank(strategy: EarnStrategy): number {
  if (strategy.hostCluster === "mainnet-beta") return 0;
  if (strategy.hostCluster === "devnet") return 1;
  return 2;
}

function StrategyDepositAction({
  availability,
  environment,
  onDeposit,
  strategy,
}: {
  availability: EarnVaultDepositAvailability;
  environment: SdpEnvironment;
  onDeposit: (strategy: EarnStrategy) => void;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  const sandboxMainnet = environment === "sandbox" && strategy.hostCluster === "mainnet-beta";
  const canDeposit = availability === "available" && !sandboxMainnet;
  const button = (
    <Button
      className={sandboxMainnet ? "pointer-events-none" : undefined}
      disabled={!canDeposit}
      iconLeft={<ArrowDownLeftIcon />}
      onClick={() => onDeposit(strategy)}
      size="sm"
      type="button"
    >
      {t("DashboardMarkets.treasury.deposit")}
    </Button>
  );

  if (!sandboxMainnet) return button;

  const reason = t("DashboardMarkets.treasury.mainnetDepositUnavailable");
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span aria-label={reason} className="inline-flex cursor-not-allowed" role="note">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs leading-5" side="top">
          {reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
  const [strategySort, setStrategySort] = useState<{
    direction: NumericSortDirection;
    field: StrategySortField;
  }>({ direction: "descending", field: "apy" });
  const sortedStrategies = useMemo(() => {
    const sortedByMetric = sortByOptionalDecimal(
      strategies,
      strategySort.field === "apy" ? (strategy) => strategy.currentApy : strategyTvlUsd,
      strategySort.direction
    );
    return sortedByMetric.sort(
      (left, right) => strategyNetworkRank(left) - strategyNetworkRank(right)
    );
  }, [strategies, strategySort]);
  const toggleStrategySort = (field: StrategySortField) => {
    setStrategySort((current) => ({
      direction:
        current.field === field && current.direction === "descending" ? "ascending" : "descending",
      field,
    }));
  };

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
              direction={strategySort.field === "apy" ? strategySort.direction : "none"}
              onToggle={() => toggleStrategySort("apy")}
            >
              {t("DashboardMarkets.treasury.apy")}
            </SortableNumericTableHead>
            <SortableNumericTableHead
              className="w-[18%]"
              direction={strategySort.field === "tvl" ? strategySort.direction : "none"}
              onToggle={() => toggleStrategySort("tvl")}
            >
              {t("DashboardMarkets.treasury.tvl")}
            </SortableNumericTableHead>
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
            const sandboxMainnet =
              environment === "sandbox" && strategy.hostCluster === "mainnet-beta";
            const provider = earnProviderLabel(strategy.provider);
            const tvlUsd = strategyTvlUsd(strategy);
            return (
              <TableRow key={strategy.id}>
                <TableCell>
                  <TreasuryPositionIdentity
                    cluster={strategy.hostCluster}
                    name={strategy.name}
                    provider={provider}
                  />
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
                <TableCell className="text-sm text-primary tabular-nums">
                  {formatUsd(tvlUsd, locale, 2)}
                </TableCell>
                <TableCell align="right">
                  <div className="flex flex-col items-end gap-2">
                    {availability === "available" || sandboxMainnet ? null : (
                      <EarnDepositAvailabilityBadge
                        availability={availability}
                        labels={TREASURY_AVAILABILITY_LABELS}
                        strategy={strategy}
                      />
                    )}
                    <StrategyDepositAction
                      availability={availability}
                      environment={environment}
                      onDeposit={onDeposit}
                      strategy={strategy}
                    />
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
  const latestActivityByPositionId = useMemo(
    () => latestVaultActivityByPosition(deposits, withdrawals),
    [deposits, withdrawals]
  );
  const positionsWithProvisionalDeposits = useMemo(
    () => displayedVaultPositions(positions, deposits),
    [deposits, positions]
  );
  const activePositions = useMemo(
    () =>
      sortByOptionalDecimal(
        positionsWithProvisionalDeposits.filter(isOpenVaultPosition),
        (position) =>
          visibleProjectedVaultBalance(position, deposits, withdrawals) ?? position.tokenValue,
        balanceSortDirection
      ),
    [balanceSortDirection, deposits, positionsWithProvisionalDeposits, withdrawals]
  );
  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet] as const));

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
                  const activity = latestActivityByPositionId.get(position.id);
                  const projectedBalance = visibleProjectedVaultBalance(
                    position,
                    deposits,
                    withdrawals
                  );
                  const displayedBalance = projectedBalance ?? position.tokenValue;
                  const formattedBalance = formatProviderAmount(displayedBalance, locale);
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
                        <span
                          className={
                            projectedBalance !== undefined
                              ? "inline-block motion-safe:animate-pulse motion-reduce:opacity-100"
                              : undefined
                          }
                          data-earn-vault-balance={
                            projectedBalance !== undefined ? "projected" : "live"
                          }
                          title={
                            projectedBalance !== undefined
                              ? t("DashboardMarkets.treasury.positionBalanceProjected")
                              : undefined
                          }
                        >
                          <span data-earn-vault-balance-value>{formattedBalance}</span>
                          {projectedBalance !== undefined ? (
                            <span className="sr-only">
                              {`. ${t("DashboardMarkets.treasury.positionBalanceProjected")}`}
                            </span>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-secondary">
                        {wallet?.label?.trim() ||
                          shortenMarketAddress(wallet?.publicKey ?? position.custodyWalletId)}
                      </TableCell>
                      <TableCell>
                        <TreasuryPositionStatusBadge activity={activity} />
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

interface TreasuryStrategiesCardProps {
  devnetError: unknown;
  devnetLoading: boolean;
  environment: SdpEnvironment;
  error: unknown;
  isLoading: boolean;
  onDeposit: (strategy: EarnStrategy) => void;
  onRefresh: () => void;
  positions: readonly EarnVaultPosition[] | undefined;
  providerAccess: EarnProviderAccess | null;
  strategies: readonly EarnStrategy[] | undefined;
  unrecordedShareMints: ReadonlySet<string> | undefined;
}

function DevnetCatalogueStatus({
  error,
  hasStrategies,
  isLoading,
}: {
  error: unknown;
  hasStrategies: boolean;
  isLoading: boolean;
}) {
  const t = useTranslations();
  if (!hasStrategies) return null;
  if (error) {
    return (
      <div
        className="flex items-center gap-2 border-b border-warning-border bg-warning-bg px-6 py-3 text-xs leading-5 text-warning"
        role="alert"
      >
        <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
        <p>{t("DashboardMarkets.treasury.devnetStrategiesUnavailable")}</p>
      </div>
    );
  }
  if (!isLoading) return null;
  return (
    <div
      className="flex items-center gap-2 border-b border-border-default bg-fill-subtle px-6 py-3 text-xs leading-5 text-secondary"
      role="status"
    >
      <RefreshCwIcon aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
      <p>{t("DashboardMarkets.treasury.devnetStrategiesLoading")}</p>
    </div>
  );
}

function TreasuryStrategiesCardBody({
  devnetError,
  devnetLoading,
  environment,
  error,
  isLoading,
  onDeposit,
  positions,
  providerAccess,
  strategies,
  unrecordedShareMints,
}: Omit<TreasuryStrategiesCardProps, "onRefresh">) {
  const t = useTranslations();
  if (isLoading) {
    return (
      <div className="grid gap-3 px-6 py-5">
        <SkeletonBlock className="h-14 rounded-xl" />
        <SkeletonBlock className="h-14 rounded-xl" />
        <SkeletonBlock className="h-14 rounded-xl" />
      </div>
    );
  }
  if (error) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.treasury.strategiesErrorDescription")}
        icon={<InfoIcon aria-hidden="true" className="size-5" />}
        message={t("DashboardMarkets.treasury.strategiesErrorTitle")}
      />
    );
  }
  const availableStrategies = strategies ?? [];
  return (
    <>
      <DevnetCatalogueStatus
        error={devnetError}
        hasStrategies={availableStrategies.length > 0}
        isLoading={devnetLoading}
      />
      {availableStrategies.length === 0 ? (
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
          strategies={availableStrategies}
          unrecordedShareMints={unrecordedShareMints}
        />
      )}
    </>
  );
}

function treasuryStrategiesDisclosureKey(
  depositsEnabled: boolean,
  providerAccess: EarnProviderAccess | null
) {
  if (providerAccess === null) return "DashboardMarkets.treasury.accessDisclosure" as const;
  if (depositsEnabled) return "DashboardMarkets.treasury.rateDisclosure" as const;
  return "DashboardMarkets.treasury.productionDisclosure" as const;
}

function TreasuryStrategiesCard({
  onRefresh,
  providerAccess,
  ...bodyProps
}: TreasuryStrategiesCardProps) {
  const t = useTranslations();
  const depositsEnabled = SURFACED_VAULT_DIRECT_EARN_PROVIDERS.some((provider) =>
    isVaultDirectDepositEnabled(bodyProps.environment, provider)
  );

  return (
    <section>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex items-center gap-1 text-[19px] leading-6 font-medium text-primary">
          {t("DashboardMarkets.treasury.strategiesTitle")}
          <TreasuryInfoTip
            label={t(treasuryStrategiesDisclosureKey(depositsEnabled, providerAccess))}
          />
        </h2>
        <div className="flex items-center gap-2">
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
        <TreasuryStrategiesCardBody providerAccess={providerAccess} {...bodyProps} />
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

function treasuryShareMints(
  positions: readonly EarnVaultPosition[] | undefined,
  strategies: readonly EarnStrategy[] | undefined,
  strategiesError: unknown
): VaultShareMintVocabulary {
  const known = new Set<string>();
  for (const position of positions ?? []) {
    if (!WELL_KNOWN_TOKEN_BY_MINT.get(position.shareMint)?.isUsdStable) {
      known.add(position.shareMint);
    }
  }
  for (const strategy of strategies ?? []) {
    const shareMint = strategy.shareMint;
    if (shareMint && !WELL_KNOWN_TOKEN_BY_MINT.get(shareMint)?.isUsdStable) {
      known.add(shareMint);
    }
  }
  return {
    known,
    complete:
      strategies !== undefined &&
      !strategiesError &&
      strategies.every((strategy) => strategy.shareMint !== undefined),
  };
}

function availableValue<Value>(error: unknown, value: Value | undefined): Value | undefined {
  return error ? undefined : value;
}

function treasuryPortfolioApy(
  allocation: TreasuryAllocation,
  positions: readonly EarnVaultPosition[] | undefined,
  positionsError: unknown,
  strategies: readonly EarnStrategy[] | undefined,
  strategiesError: unknown
): string | undefined {
  if (allocation.deployedValue === undefined || positionsError || strategiesError) return undefined;
  return estimatedTreasuryApy({ positions, strategies });
}

function treasurySummaryLoading(input: {
  positionsError: unknown;
  positionsLoading: boolean;
  strategiesError: unknown;
  strategiesLoading: boolean;
  walletsError: unknown;
  walletsLoading: boolean;
}): boolean {
  const {
    positionsError,
    positionsLoading,
    strategiesError,
    strategiesLoading,
    walletsError,
    walletsLoading,
  } = input;
  if (walletsError || positionsError || strategiesError) return false;
  return walletsLoading || positionsLoading || strategiesLoading;
}

interface TreasuryWorkspaceContentProps {
  activeWallets: readonly EarnFundingWallet[];
  allocation: TreasuryAllocation;
  catalogueError: unknown;
  catalogueLoading: boolean;
  catalogueStrategies: readonly EarnStrategy[] | undefined;
  devnetCatalogueError: unknown;
  devnetCatalogueLoading: boolean;
  environment: SdpEnvironment;
  onDeposit: (strategy: EarnStrategy) => void;
  onRefresh: () => void;
  onWithdrawPosition: (position: EarnVaultPosition) => void;
  onWithdrawProgram: (program: EarnProgram) => void;
  portfolioApy: string | undefined;
  positions: readonly EarnVaultPosition[] | undefined;
  positionsError: unknown;
  positionsLoading: boolean;
  programs: readonly EarnProgram[];
  programsLoading: boolean;
  programsUnavailable: boolean;
  providerAccess: EarnProviderAccess | null;
  summaryLoading: boolean;
  vaultDeposits: readonly TrackedVaultDeposit[];
  vaultWithdrawals: readonly TrackedVaultWithdrawal[];
  walletsError: unknown;
  walletsLoading: boolean;
}

function TreasuryWorkspaceContent(props: TreasuryWorkspaceContentProps) {
  const {
    activeWallets,
    allocation,
    catalogueError,
    catalogueLoading,
    catalogueStrategies,
    devnetCatalogueError,
    devnetCatalogueLoading,
    environment,
    onDeposit,
    onRefresh,
    onWithdrawPosition,
    onWithdrawProgram,
    portfolioApy,
    positions,
    positionsError,
    positionsLoading,
    programs,
    programsLoading,
    programsUnavailable,
    providerAccess,
    summaryLoading,
    vaultDeposits,
    vaultWithdrawals,
    walletsError,
    walletsLoading,
  } = props;
  const t = useTranslations();

  return (
    <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-16">
      <TreasuryAllocationCard
        allocation={allocation}
        estimatedApy={portfolioApy}
        isLoading={summaryLoading}
      />

      <TreasuryWalletsCard
        allocation={allocation}
        error={walletsError}
        isLoading={walletsLoading}
        wallets={activeWallets}
      />

      <ActiveVaultPositionsCard
        deposits={vaultDeposits}
        error={positionsError}
        isLoading={positionsLoading}
        onWithdraw={onWithdrawPosition}
        positions={positionsError ? undefined : positions}
        unrecordedShareMints={allocation.unrecordedShareMints}
        wallets={activeWallets}
        withdrawals={vaultWithdrawals}
      />

      <TreasuryStrategiesCard
        devnetError={devnetCatalogueError}
        devnetLoading={devnetCatalogueLoading}
        environment={environment}
        error={catalogueError}
        isLoading={catalogueLoading}
        onDeposit={onDeposit}
        onRefresh={onRefresh}
        positions={positionsError ? undefined : positions}
        providerAccess={providerAccess}
        strategies={catalogueStrategies}
        unrecordedShareMints={allocation.unrecordedShareMints}
      />

      {programsLoading ? <SkeletonBlock className="h-48 rounded-xl" /> : null}
      {programsUnavailable ? (
        <Card className="px-6 py-5">
          <p className="text-sm text-secondary">
            {t("DashboardMarkets.treasury.existingProgramsUnavailable")}
          </p>
        </Card>
      ) : (
        <ExistingProgramsCard programs={programs} onWithdraw={onWithdrawProgram} />
      )}
    </div>
  );
}

function mergeStrategyCatalogues(
  mainnet: readonly EarnStrategy[] | undefined,
  devnet: readonly EarnStrategy[] | undefined
): EarnStrategy[] | undefined {
  if (!mainnet) return undefined;
  if (!devnet) return [...mainnet];

  const combined = [...mainnet];
  const seen = new Set(mainnet.map((strategy) => strategy.id));
  for (const strategy of devnet) {
    if (seen.has(strategy.id)) continue;
    seen.add(strategy.id);
    combined.push(strategy);
  }
  return combined;
}

export function TreasurySolutionsWorkspace({
  providerAccess,
}: {
  providerAccess: EarnProviderAccess | null;
}) {
  const { sdpEnvironment, selectedProjectId } = useDashboardWorkspace();
  const {
    wallets,
    error: walletsError,
    isLoading: walletsLoading,
    refreshBalances: refreshWalletBalances,
  } = useEarnFundingWallets();
  const {
    strategies,
    error: strategiesError,
    isLoading: strategiesLoading,
    refresh: refreshStrategies,
  } = useEarnStrategies();
  // The allocation summary still reads the environment's actionable shelf.
  // Sandbox automatically combines that devnet shelf with the mirrored
  // mainnet catalogue, preserving the API's `fundable: false` response on
  // mainnet rows. Production's default shelf is already mainnet.
  const catalogueCluster = sdpEnvironment === "sandbox" ? "mainnet-beta" : undefined;
  const {
    strategies: baseCatalogueStrategies,
    error: baseCatalogueError,
    isLoading: baseCatalogueLoading,
    refresh: refreshCatalogue,
  } = useEarnStrategies({ cluster: catalogueCluster });
  const catalogueStrategies = useMemo(
    () =>
      sdpEnvironment === "sandbox"
        ? mergeStrategyCatalogues(baseCatalogueStrategies, strategiesError ? undefined : strategies)
        : baseCatalogueStrategies,
    [baseCatalogueStrategies, sdpEnvironment, strategies, strategiesError]
  );
  const catalogueError = baseCatalogueError;
  const devnetCatalogueError = sdpEnvironment === "sandbox" ? strategiesError : undefined;
  const devnetCatalogueLoading = sdpEnvironment === "sandbox" && strategiesLoading;
  const catalogueLoading =
    baseCatalogueLoading || (sdpEnvironment === "sandbox" && strategiesLoading);
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
              ...next[existingIndex],
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
              ...next[existingIndex],
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

  const updateVaultDepositWatch = useCallback((updatedDeposit: EarnVaultDepositRecord) => {
    setVaultDepositWatches((current) => replaceTrackedVaultMovement(current, updatedDeposit));
  }, []);
  const updateVaultWithdrawalWatch = useCallback((updatedWithdrawal: EarnVaultWithdrawal) => {
    setVaultWithdrawalWatches((current) => replaceTrackedVaultMovement(current, updatedWithdrawal));
  }, []);

  // Each movement owns its status, provisional row, and balance projection.
  // Provider hydration only clears those presentation hints once it can replace
  // them, so the modal and table never race separate client-side state stores.
  useEffect(() => {
    setVaultDepositWatches((current) => {
      let changed = false;
      const next = current.map((deposit) => {
        const position = positions?.find((candidate) => candidate.id === deposit.positionId);
        const clearProvisional =
          deposit.provisionalPosition !== undefined && position !== undefined;
        const clearProjection =
          deposit.balanceProjection !== undefined &&
          balanceProjectionReachedProvider(deposit.balanceProjection, "deposit", position);
        if (!clearProvisional && !clearProjection) return deposit;
        changed = true;
        const { balanceProjection, provisionalPosition, ...movement } = deposit;
        return {
          ...movement,
          ...(clearProjection ? {} : { balanceProjection }),
          ...(clearProvisional ? {} : { provisionalPosition }),
        };
      });
      return changed ? next : current;
    });
    setVaultWithdrawalWatches((current) => {
      let changed = false;
      const next = current.map((withdrawal) => {
        const projection = withdrawal.balanceProjection;
        if (
          !projection ||
          !balanceProjectionReachedProvider(
            projection,
            "withdrawal",
            positions?.find((candidate) => candidate.id === withdrawal.positionId)
          )
        ) {
          return withdrawal;
        }
        changed = true;
        const { balanceProjection: _, ...movement } = withdrawal;
        return movement;
      });
      return changed ? next : current;
    });
  }, [positions]);

  useEffect(() => {
    const projections = [...vaultDepositWatches, ...vaultWithdrawalWatches].flatMap(
      ({ balanceProjection }) => (balanceProjection ? [balanceProjection] : [])
    );
    if (projections.length === 0) return;
    const nextExpiry = Math.min(...projections.map(({ expiresAt }) => expiresAt));
    const timeout = window.setTimeout(
      () => {
        const clearExpiredProjection = <
          Movement extends { balanceProjection?: VaultBalanceProjection },
        >(
          current: readonly Movement[]
        ): readonly Movement[] => {
          let changed = false;
          const next = current.map((movement) => {
            if (!movement.balanceProjection || movement.balanceProjection.expiresAt > Date.now()) {
              return movement;
            }
            changed = true;
            const { balanceProjection: _, ...remaining } = movement;
            return remaining as unknown as Movement;
          });
          return changed ? next : current;
        };
        setVaultDepositWatches(clearExpiredProjection);
        setVaultWithdrawalWatches(clearExpiredProjection);
      },
      Math.max(0, nextExpiry - Date.now())
    );
    return () => window.clearTimeout(timeout);
  }, [vaultDepositWatches, vaultWithdrawalWatches]);

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
  const shareMints = treasuryShareMints(positions, strategies, strategiesError);
  // Every figure on this page comes from here, so no two surfaces can compute
  // the same thing differently.
  const allocation = summarizeTreasuryAllocation({
    positions: availableValue(positionsError, positions),
    shareMints,
    wallets: availableValue(walletsError, wallets),
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
  const portfolioApy = treasuryPortfolioApy(
    allocation,
    positions,
    positionsError,
    strategies,
    strategiesError
  );
  const summaryLoading = treasurySummaryLoading({
    positionsError,
    positionsLoading,
    strategiesError,
    strategiesLoading,
    walletsError,
    walletsLoading,
  });

  return (
    <DashboardWorkspaceOverviewPanel>
      <TreasuryWorkspaceContent
        activeWallets={activeWallets}
        allocation={allocation}
        catalogueError={catalogueError}
        catalogueLoading={catalogueLoading && catalogueStrategies === undefined}
        catalogueStrategies={catalogueStrategies}
        devnetCatalogueError={devnetCatalogueError}
        devnetCatalogueLoading={devnetCatalogueLoading}
        environment={sdpEnvironment}
        onDeposit={setDepositStrategy}
        onRefresh={() => {
          refreshWalletBalances();
          refreshStrategies();
          if (catalogueCluster !== undefined) refreshCatalogue();
          refreshPositions();
          refreshPrograms();
        }}
        onWithdrawPosition={setWithdrawPosition}
        onWithdrawProgram={setWithdrawProgram}
        portfolioApy={portfolioApy}
        positions={positions}
        positionsError={positionsError}
        positionsLoading={positionsLoading}
        programs={programs}
        programsLoading={programsLoading}
        programsUnavailable={Boolean(programsError || programsState?.kind === "unconfigured")}
        providerAccess={providerAccess}
        summaryLoading={summaryLoading}
        vaultDeposits={vaultDepositWatches}
        vaultWithdrawals={vaultWithdrawalWatches}
        walletsError={walletsError}
        walletsLoading={walletsLoading}
      />

      {depositStrategy ? (
        <EarnVaultDepositModal
          onClose={() => setDepositStrategy(null)}
          projectId={selectedProjectId}
          onDeposited={(deposit, intent) => {
            // Two refreshes, for two different moments. This starts an
            // uncached balance read for a fast landing; the watch below reads
            // again once the chain has actually decided, which is the only
            // point at which the holding is real.
            const authoritativePosition = positions?.find(
              (position) => position.id === deposit.positionId
            );
            const provisionalPosition = authoritativePosition
              ? undefined
              : provisionalVaultPosition(deposit, intent.custodyWalletId, depositStrategy);
            const baselineValue =
              currentVaultBalance(
                deposit.positionId,
                positions,
                vaultDepositWatches,
                vaultWithdrawalWatches
              ) ?? (provisionalPosition ? "0" : undefined);
            const balanceProjection = intent.projectBalance
              ? createVaultBalanceProjection(baselineValue, intent.amount, "deposit")
              : undefined;
            addVaultDepositWatches([
              {
                balanceProjection,
                failureReason: deposit.failureReason,
                movementId: deposit.movementId,
                positionId: deposit.positionId,
                provisionalPosition,
                status: deposit.status,
              },
            ]);
            refreshPositions();
            refreshWalletBalances();
          }}
          onMovementUpdated={updateVaultDepositWatch}
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
          onWithdrawn={(withdrawal, intent) => {
            const balanceProjection = intent.projectBalance
              ? createVaultBalanceProjection(
                  currentVaultBalance(
                    withdrawal.positionId,
                    positions,
                    vaultDepositWatches,
                    vaultWithdrawalWatches
                  ),
                  intent.amount,
                  "withdrawal"
                )
              : undefined;
            addVaultWithdrawalWatches([
              {
                balanceProjection,
                createdAt: withdrawal.createdAt,
                failureReason: withdrawal.failureReason,
                movementId: withdrawal.movementId,
                positionId: withdrawal.positionId,
                status: withdrawal.status,
              },
            ]);
            refreshPositions();
            refreshWalletBalances();
          }}
          onMovementUpdated={updateVaultWithdrawalWatch}
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
          onUpdated={updateVaultWithdrawalWatch}
          onSettled={(settledWithdrawal) => {
            updateVaultWithdrawalWatch(settledWithdrawal);
            setSettledVaultWithdrawalIds((current) =>
              new Set(current).add(settledWithdrawal.movementId)
            );
            // Only now did the exit change what the org holds: the shares are
            // burned and the proceeds sit in the custody wallet.
            refreshPositions();
            refreshWalletBalances();
          }}
        />
      ))}

      {activeVaultDepositWatches.map((deposit) => (
        <EarnVaultDepositOutcomeTracker
          key={`vault-deposit:${deposit.movementId}`}
          movementId={deposit.movementId}
          onUpdated={updateVaultDepositWatch}
          onSettled={(settledDeposit) => {
            updateVaultDepositWatch(settledDeposit);
            setSettledVaultDepositIds((current) => new Set(current).add(settledDeposit.movementId));
            // Only NOW is the position real: the shares exist on chain and the
            // wallet balance reflects what left it.
            refreshPositions();
            refreshWalletBalances();
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
