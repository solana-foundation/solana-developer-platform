"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type EarnPortfolioWalletStatus,
  type EarnProgram,
  type EarnStrategy,
  type EarnVaultPosition,
  isEarnVaultHoldingEmpty,
} from "@sdp/types/earn";
import {
  earnProgramSolanaPayoutTokens,
  isVaultDirectDepositEnabled,
} from "@sdp/types/provider-access";
import { SOLANA_CLUSTER_LABELS } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { cn } from "@sdp/ui/cn";
import { InfoHint } from "@sdp/ui/info-hint";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { StatusText, type StatusTone } from "@sdp/ui/status-text";
import { TableCell } from "@sdp/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sdp/ui/tooltip";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, InfoIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import {
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/dashboard/[projectId]/custody/provider-catalog";
import { formatWalletPurposeLabel } from "@/app/dashboard/[projectId]/custody/wallet-format-utils";
import { WalletProviderMark } from "@/app/dashboard/[projectId]/custody/wallet-provider-mark";
import type { EarnFundingWallet } from "@/app/dashboard/[projectId]/markets/earn/deposit/earn-funding-wallets";
import {
  compareUnsignedDecimals,
  isPositiveDecimal,
  sortByOptionalDecimal,
} from "@/app/dashboard/[projectId]/markets/earn/earn-decimal";
import {
  type EarnDepositAvailabilityLabels,
  earnDepositAvailabilityLabel,
  earnDetailLine,
  earnProviderLabel,
  formatProviderAmount,
  formatTokenValue,
  formatUsd,
  positionDisplayName,
  shortenMarketAddress,
} from "@/app/dashboard/[projectId]/markets/earn/earn-format";
import {
  earnMintAsset,
  earnStrategyAsset,
  earnStrategyReferenceKey,
  formatProviderApy,
  sumDecimalStrings,
} from "@/app/dashboard/[projectId]/markets/earn/earn-market-presentation";
import {
  EarnRowIdentity,
  EarnSummary,
} from "@/app/dashboard/[projectId]/markets/earn/earn-page-blocks";
import {
  type EarnProviderAccess,
  earnVaultDepositAvailability,
  SURFACED_VAULT_DIRECT_EARN_PROVIDERS,
} from "@/app/dashboard/[projectId]/markets/earn/earn-surfacing";
import {
  EARN_TABLE,
  EARN_TABLE_FRAME,
} from "@/app/dashboard/[projectId]/markets/earn/earn-table-layout";
import { earnVaultHoldingValue } from "@/app/dashboard/[projectId]/markets/earn/earn-vault-holding";
import type { EarnVaultParRedemptionSource } from "@/app/dashboard/[projectId]/markets/earn/earn-vault-par-redemption-modal";
import {
  type EarnVaultPositionUiStatus,
  earnVaultDepositUiState,
  earnVaultPositionStatusLabels,
  earnVaultWithdrawalUiState,
} from "@/app/dashboard/[projectId]/markets/earn/earn-vault-ui-state";
import { EarnVaultWithdrawalRequestsCard } from "@/app/dashboard/[projectId]/markets/earn/earn-vault-withdrawal-requests-card";
import {
  EarnSummarySkeleton,
  EarnTableSkeleton,
  TreasuryWalletTilesSkeleton,
} from "@/app/dashboard/[projectId]/markets/markets-route-skeletons";
import {
  PAYMENTS_TABLE_CELL,
  PAYMENTS_TABLE_HEAD,
} from "@/app/dashboard/[projectId]/payments/payments-table";
import { RecordBlock, RecordStack } from "@/components/refresh-record";
import { useCanWrite, useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { type KaminoVaultAllocationsRead, kaminoAllocationsVault } from "./kamino-allocations";
import {
  formatAllocationWeight,
  formatKaminoAsOf,
  hasKaminoAllocationContent,
  kaminoDeployedWeightPct,
  kaminoDisclosureRows,
  kaminoMarketLabel,
} from "./kamino-allocations-format";
import type { KaminoVaultAllocations } from "./kamino-allocations-schema";
import {
  isOpenVaultPosition,
  type TreasuryAllocation,
  type WalletDeploymentDisplay,
} from "./treasury-allocation";
import {
  TREASURY_POSITION_COLUMNS,
  TREASURY_POSITIONS_BODY,
  TREASURY_PROGRAM_COLUMNS,
  TREASURY_STRATEGIES_BODY,
  TREASURY_STRATEGY_COLUMNS,
  TREASURY_WALLET_GRID,
  TREASURY_WALLETS_BODY,
} from "./treasury-layout";
import type { TrackedVaultDeposit, TrackedVaultWithdrawal } from "./treasury-solutions-workspace";
import { vaultActivities } from "./treasury-vault-balance";
import type { TreasuryPositionBalance } from "./use-treasury-balances";

type TrackedVaultActivity = ReturnType<
  typeof vaultActivities<TrackedVaultDeposit, TrackedVaultWithdrawal>
>[number];

type NumericSortDirection = "ascending" | "descending";
type NumericSortState = NumericSortDirection | "none";
type StrategySortField = "apy" | "tvl";

const TREASURY_AVAILABILITY_LABELS = {
  available: "DashboardMarkets.treasury.depositAvailable",
  cluster_unavailable: "DashboardMarkets.treasury.clusterUnavailable",
  strategy_unavailable: "DashboardMarkets.treasury.depositUnavailable",
  environment_unavailable: "DashboardMarkets.treasury.productionUnavailable",
  access_unavailable: "DashboardMarkets.treasury.accessUnavailable",
  provider_unavailable: "DashboardMarkets.treasury.providerUnavailable",
  production_only: "DashboardMarkets.treasury.sandboxUnavailable",
} as const satisfies EarnDepositAvailabilityLabels;

/** When a stale balance was last verified, in UTC so every reader sees the same instant. */
const VERIFIED_AT_FORMAT = {
  timeZone: "UTC",
  timeZoneName: "short",
} as const satisfies Intl.DateTimeFormatOptions;

/** A custodial program wallet's state, as words in their tone. */
const PROGRAM_STATUS_DISPLAY = {
  creating: { labelKey: "DashboardMarkets.treasury.programStatusCreating", tone: "progress" },
  ready: { labelKey: "DashboardMarkets.treasury.programStatusReady", tone: "positive" },
  busy: { labelKey: "DashboardMarkets.treasury.programStatusBusy", tone: "progress" },
  failed: { labelKey: "DashboardMarkets.treasury.programStatusFailed", tone: "critical" },
} as const satisfies Record<
  EarnPortfolioWalletStatus,
  {
    labelKey: `DashboardMarkets.treasury.programStatus${string}`;
    tone: StatusTone;
  }
>;

/**
 * A wire decimal that can be compared. Strategy rows are provider-supplied,
 * so an unparseable value ranks as unknown (last) rather than being trusted
 * to compare.
 */
function knownWireDecimal(value: string | undefined): string | undefined {
  return value !== undefined && compareUnsignedDecimals(value, "0") !== undefined
    ? value
    : undefined;
}

function strategyTvlUsd(strategy: EarnStrategy): string | undefined {
  const tvl = strategy.riskMetadata?.tvlUsd;
  return typeof tvl === "number" && Number.isFinite(tvl) && tvl >= 0 ? String(tvl) : undefined;
}

function strategyNetworkRank(strategy: EarnStrategy): number {
  if (strategy.hostCluster === "mainnet-beta") return 0;
  if (strategy.hostCluster === "devnet") return 1;
  return 2;
}

function latestVaultActivityByPosition(
  activities: readonly TrackedVaultActivity[]
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
  for (const activity of activities) rememberLatest(activity);
  return latestActivityByPositionId;
}

/**
 * The positions the table lists, newest first as the API orders them: a just-submitted
 * deposit's provisional row leads until the API lists the position itself, so the row keeps
 * its place when it does.
 */
function displayedVaultPositions(
  positions: readonly EarnVaultPosition[] | undefined,
  deposits: readonly TrackedVaultDeposit[]
): EarnVaultPosition[] {
  const authoritative = positions ?? [];
  const shownIds = new Set(authoritative.map(({ id }) => id));
  const provisional: EarnVaultPosition[] = [];
  for (const deposit of [...deposits].reverse()) {
    const position = deposit.provisionalPosition;
    if (deposit.status === "failed" || !position || shownIds.has(position.id)) continue;
    provisional.push(position);
    shownIds.add(position.id);
  }
  return [...provisional, ...authoritative];
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
  // and that wallet's tile, which both read unavailable here. Without the
  // witness at all, "no active position" is equally unsupportable.
  const unrecorded =
    unrecordedShareMints === undefined ||
    (strategy.shareMint !== undefined && unrecordedShareMints.has(strategy.shareMint));
  if (unrecorded) return { count: active.length, unrecorded };
  if (active.length === 0) return { count: 0 };
  const values = active.map(earnVaultHoldingValue);
  if (values.some((value) => value === undefined)) return { count: active.length };
  return { count: active.length, value: sumDecimalStrings(values as string[]) };
}

function programName(program: EarnProgram, fallback: string): string {
  const positionName = program.wallet.positions.find(
    (position) => position.kind === "yield_source"
  )?.label;
  return program.label?.trim() || positionName?.trim() || fallback;
}

function treasuryStrategiesDisclosureKey(
  depositsEnabled: boolean,
  providerAccess: EarnProviderAccess | null
) {
  if (providerAccess === null) return "DashboardMarkets.treasury.accessDisclosure" as const;
  if (depositsEnabled) return "DashboardMarkets.treasury.rateDisclosure" as const;
  return "DashboardMarkets.treasury.productionDisclosure" as const;
}

/** Where a position's balance read stands, for tests and tooling reading the row. */
function balanceReadState(
  syncing: boolean,
  lastVerifiedAt: number | undefined
): "syncing" | "stale" | "live" {
  if (syncing) return "syncing";
  if (lastVerifiedAt !== undefined) return "stale";
  return "live";
}

/**
 * A figure whose read is in flight: a placeholder the figure's own size, so the row keeps its
 * height, named for assistive tech. Affected amounts wait for a verified read rather than
 * showing the one before the movement.
 */
function BalanceRefreshing({ className }: { className: string }) {
  const t = useTranslations();
  const label = t("DashboardMarkets.treasury.positionBalanceSyncing");
  return (
    <div aria-label={label} className="flex items-center" role="status">
      <span className="sr-only">{label}</span>
      <SkeletonBlock className={className} />
    </div>
  );
}

function SortableNumericTableHead({
  children,
  className,
  direction,
  onToggle,
}: {
  children: ReactNode;
  className: string;
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
    <TableHead aria-sort={direction} className={cn(PAYMENTS_TABLE_HEAD, className)}>
      <button
        className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 text-inherit transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
        onClick={onToggle}
        type="button"
      >
        <SortIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", direction === "none" && "opacity-50")}
        />
        <span>{children}</span>
      </button>
    </TableHead>
  );
}

/**
 * The page's summary: what is deposited is the hero figure, then the stat line with the cash still
 * in custody and the rate the positions earn.
 */
function TreasurySummary({
  allocation,
  estimatedApy,
  isLoading,
  refreshing,
}: {
  allocation: TreasuryAllocation;
  estimatedApy: string | undefined;
  isLoading: boolean;
  refreshing: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (isLoading) return <EarnSummarySkeleton />;

  const deployedHint =
    allocation.deployedValue !== undefined
      ? undefined
      : allocation.deployedAbsence === "unreconciled"
        ? t("DashboardMarkets.treasury.summaryDeployedUnreconciled")
        : t("DashboardMarkets.treasury.summaryDeployedUnavailable");
  return (
    <EarnSummary
      figure={
        refreshing ? (
          <BalanceRefreshing className="h-11 w-40" />
        ) : (
          formatUsd(allocation.deployedValue, locale)
        )
      }
      hint={deployedHint}
      label={t("DashboardMarkets.treasury.summaryDeposited")}
      stats={[
        {
          id: "cash",
          hint: t(
            allocation.availableCash === undefined
              ? "DashboardMarkets.treasury.summaryCashUnavailable"
              : "DashboardMarkets.treasury.summaryCashCaption"
          ),
          label: t("DashboardMarkets.treasury.summaryLineCash"),
          value: refreshing ? (
            <BalanceRefreshing className="h-4 w-12" />
          ) : (
            formatUsd(allocation.availableCash, locale)
          ),
        },
        {
          id: "apy",
          hint: t(
            estimatedApy === undefined
              ? "DashboardMarkets.treasury.summaryApyUnavailable"
              : "DashboardMarkets.treasury.summaryApyCaption"
          ),
          label: t("DashboardMarkets.treasury.summaryLineApy"),
          value: refreshing ? (
            <BalanceRefreshing className="h-4 w-12" />
          ) : (
            formatProviderApy(estimatedApy, locale)
          ),
        },
      ]}
    />
  );
}

/** What a wallet has deployed: its open positions' value, zero when it holds none. */
function WalletDeployedFigure({
  deployment,
  refreshing,
}: {
  deployment: WalletDeploymentDisplay;
  refreshing: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (refreshing) return <BalanceRefreshing className="h-3.5 w-14" />;
  switch (deployment.kind) {
    case "value":
      return formatUsd(deployment.value, locale);
    case "none":
      return formatUsd("0", locale);
    case "unavailable":
      return (
        <span className="truncate text-tertiary">
          {t("DashboardMarkets.treasury.positionValueUnavailable")}
        </span>
      );
    default: {
      const unhandled: never = deployment;
      return unhandled;
    }
  }
}

/** A tile's figure: a 13px caption over its 14px value. */
function TreasuryTileFigure({ children, label }: { children: ReactNode; label: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex h-4 items-center gap-1.5 text-meta text-tertiary">{label}</dt>
      <dd className="flex h-5 items-center text-body text-primary tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * One custody wallet as the Wallets page tiles it: its provider mark, name and kind, and what it
 * holds for Earn: the cash still in it and what it has deployed. The whole tile opens the
 * wallet.
 */
function TreasuryWalletTile({
  allocation,
  refreshing,
  wallet,
}: {
  allocation: TreasuryAllocation;
  refreshing: boolean;
  wallet: EarnFundingWallet;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const href = useProjectHref();
  const provider =
    wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
  const name = wallet.label?.trim() || t("DashboardMarkets.treasury.unnamedWallet");
  const kind = [
    formatWalletPurposeLabel(wallet.purpose, t),
    provider
      ? formatCustodyProviderName(provider)
      : (wallet.provider ?? t("DashboardMarkets.treasury.walletProviderUnknown")),
  ]
    .filter(Boolean)
    .join(" · ");
  // Straight from the same result the summary rendered, so the two cannot disagree about
  // this wallet.
  const deployment = allocation.deploymentByWalletId.get(wallet.id) ?? {
    kind: "none" as const,
  };
  return (
    <article
      className="relative flex min-w-0 flex-col rounded-card bg-surface-tile"
      data-treasury-wallet={wallet.id}
    >
      <Link
        className="absolute inset-0 rounded-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        href={href(`${DASHBOARD_SIDE_NAV_HREFS.wallets}/${encodeURIComponent(wallet.walletId)}`)}
      >
        <span className="sr-only">{t("DashboardCustody.openWalletNamed", { wallet: name })}</span>
      </Link>
      <div className="flex items-center gap-3 px-4 pt-4">
        {provider ? (
          <WalletProviderMark provider={provider} size="row" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border-subtle text-body font-medium text-tertiary"
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-nav font-medium text-primary">{name}</p>
          <p className="truncate text-body text-secondary" title={wallet.publicKey}>
            {kind || shortenMarketAddress(wallet.publicKey)}
          </p>
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 border-t border-border-subtle px-4 pt-3 pb-3">
        <TreasuryTileFigure
          label={
            <>
              {t("DashboardMarkets.treasury.summaryCash")}
              {/* Above the tile's link, so its hint can be hovered. */}
              <span className="relative z-10 inline-flex">
                <InfoHint text={t("DashboardMarkets.treasury.summaryCashCaption")} />
              </span>
            </>
          }
        >
          {refreshing ? (
            <BalanceRefreshing className="h-3.5 w-14" />
          ) : (
            formatUsd(allocation.cashByWalletId.get(wallet.id), locale)
          )}
        </TreasuryTileFigure>
        <TreasuryTileFigure label={t("DashboardMarkets.treasury.walletDeployed")}>
          <WalletDeployedFigure deployment={deployment} refreshing={refreshing} />
        </TreasuryTileFigure>
      </dl>
    </article>
  );
}

function TreasuryWallets({
  allocation,
  failed,
  isLoading,
  refreshing,
  wallets,
}: {
  allocation: TreasuryAllocation;
  failed: boolean;
  isLoading: boolean;
  refreshing: boolean;
  wallets: readonly EarnFundingWallet[];
}) {
  const t = useTranslations();
  const href = useProjectHref();
  const workspace = useOptionalDashboardWorkspace();
  const custodyEnabled = workspace?.flags.custody ?? true;
  const canManageCustody = workspace?.dashboardAccess.capabilities.canManageCustody ?? true;
  if (!custodyEnabled) return null;

  let body: ReactNode;
  if (isLoading) {
    body = <TreasuryWalletTilesSkeleton />;
  } else if (failed) {
    body = (
      <p className="text-body text-secondary">{t("DashboardMarkets.treasury.walletsError")}</p>
    );
  } else if (wallets.length === 0) {
    body = (
      <ListEmptyState
        action={
          canManageCustody ? (
            <Button asChild variant="outline">
              <Link href={href(`${DASHBOARD_SIDE_NAV_HREFS.wallets}/setup`)}>
                {t("DashboardCustody.createWallet")}
              </Link>
            </Button>
          ) : undefined
        }
        description={t("DashboardMarkets.treasury.walletsEmptyDescription")}
        message={t("DashboardMarkets.treasury.walletsEmptyTitle")}
      />
    );
  } else {
    body = (
      <div className={TREASURY_WALLET_GRID}>
        {wallets.map((wallet) => (
          <TreasuryWalletTile
            allocation={allocation}
            key={wallet.id}
            refreshing={refreshing}
            wallet={wallet}
          />
        ))}
      </div>
    );
  }

  // A failed or empty read sits in the middle of the tile row it replaces.
  const centered = !isLoading && (failed || wallets.length === 0);
  return (
    <RecordBlock
      aside={
        wallets.length > 0 ? (
          <Button asChild size="sm" variant="outline">
            <Link href={href(DASHBOARD_SIDE_NAV_HREFS.wallets)}>
              {t("DashboardMarkets.treasury.viewAll")}
            </Link>
          </Button>
        ) : undefined
      }
      title={t("DashboardMarkets.treasury.connectedWallets")}
    >
      <div className={cn(TREASURY_WALLETS_BODY, centered && "justify-center")}>{body}</div>
    </RecordBlock>
  );
}

const POSITION_STATUS_TONE = {
  active: "positive",
  pending: "progress",
} as const satisfies Record<EarnVaultPositionUiStatus, StatusTone>;

/**
 * Settled positions read Active, ones whose latest deposit or withdrawal is still moving read
 * Pending.
 */
function vaultPositionStatus(
  activity: TrackedVaultActivity | undefined
): EarnVaultPositionUiStatus {
  if (activity === undefined) return "active";
  if (activity.kind === "deposit") {
    return earnVaultDepositUiState(activity.movement.status).positionStatus;
  }
  return earnVaultWithdrawalUiState(activity.movement.status).positionStatus;
}

/** A position's status in its tone, explained on hover and focus. */
function TreasuryPositionStatus({ status }: { status: EarnVaultPositionUiStatus }) {
  const t = useTranslations();
  const display = earnVaultPositionStatusLabels(status, t);
  const description =
    status === "pending"
      ? t("DashboardMarkets.treasury.positionStatusPendingDescription")
      : t("DashboardMarkets.treasury.positionStatusActiveDescription");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={`${display.label}: ${description}`}
            className="inline-flex max-w-full cursor-help rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            type="button"
          >
            <StatusText className="truncate" tone={POSITION_STATUS_TONE[status]}>
              {display.label}
            </StatusText>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs leading-5">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TreasuryPositionBalanceCell({
  formattedBalance,
  parIntermediate,
  status,
  syncing,
  lastVerifiedAt,
}: {
  formattedBalance: string;
  parIntermediate: EarnVaultPosition["parIntermediate"];
  status: EarnVaultPositionUiStatus;
  syncing: boolean;
  lastVerifiedAt?: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const syncingLabel = t("DashboardMarkets.treasury.positionBalanceSyncing");
  // One line under the balance qualifies it: a stale read, the par intermediate it includes, or,
  // on a phone, where the status column drops out, the position's status. A note never shows
  // while a movement is unconfirmed, so a position that has one reads Active.
  let note: ReactNode;
  if (lastVerifiedAt !== undefined) {
    note = (
      <span
        className="block truncate text-tertiary"
        title={new Date(lastVerifiedAt).toLocaleString(locale, VERIFIED_AT_FORMAT)}
      >
        {t("DashboardMarkets.treasury.positionBalanceLastVerified")}
      </span>
    );
  } else if (parIntermediate !== undefined && !syncing) {
    // Wraps rather than truncates, so the amount reads whole.
    note = (
      <span
        className="block whitespace-normal text-pretty text-tertiary"
        data-earn-vault-par-intermediate
      >
        {t("DashboardEarn.parRedemption.positionIntermediate", {
          amount: formatProviderAmount(parIntermediate.amount, locale),
        })}
      </span>
    );
  } else {
    note = (
      <StatusText className="block truncate @2xl:hidden" tone={POSITION_STATUS_TONE[status]}>
        {earnVaultPositionStatusLabels(status, t).label}
      </StatusText>
    );
  }
  return (
    <TableCell
      className={cn(
        PAYMENTS_TABLE_CELL,
        TREASURY_POSITION_COLUMNS.balance,
        "text-primary tabular-nums"
      )}
    >
      <div
        className="flex h-5 items-center justify-end"
        data-earn-vault-balance={balanceReadState(syncing, lastVerifiedAt)}
        title={syncing ? syncingLabel : undefined}
      >
        <div data-earn-vault-balance-value>
          {syncing ? (
            <>
              <span className="sr-only">{syncingLabel}</span>
              <SkeletonBlock className="h-3.5 w-12" />
            </>
          ) : (
            formattedBalance
          )}
        </div>
      </div>
      {parIntermediate === undefined ? (
        note
      ) : (
        // The par note wraps to three lines at most (its amount never breaks), and the cell
        // keeps them whatever the read shows, so the note can give way to a sync or a stale
        // read without moving the rows below.
        <div className="min-h-15" data-earn-vault-par-slot>
          {note}
        </div>
      )}
    </TableCell>
  );
}

function TreasuryPositionActions({
  onWithdraw,
  position,
}: {
  onWithdraw: (position: EarnVaultPosition, parSource?: EarnVaultParRedemptionSource) => void;
  position: EarnVaultPosition;
}) {
  const t = useTranslations();
  const canWrite = useCanWrite();
  // The exit routes (PRO-1702). Deliberately NOT gated on availability,
  // surfacing, or environment: money out beats money off (ADR 0002), so the
  // verbs stay live wherever a position exists. A provider whose exit SDP
  // cannot build yet answers 501 with a clear error inside the modal rather
  // than a silently dead button. Unhydrated shares may still exist, so only a
  // provable zero (a row kept open by its par intermediate) hides the share
  // exit; a held par intermediate gets its own verb, since only the par route
  // can redeem it.
  const holdsShares =
    position.shares === undefined || !isEarnVaultHoldingEmpty({ shares: position.shares });
  const redeemable = position.parIntermediate?.withdrawableAmount;
  const holdsIntermediate = redeemable !== undefined && isPositiveDecimal(redeemable);
  // A read-only member (`viewer`) sees the position but no exit, which the API refuses them.
  if (!canWrite) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {holdsIntermediate ? (
        // A phone's action slot fits the verb alone, so the token drops from the label there;
        // the button's name keeps it at every width.
        <Button
          aria-label={t("DashboardMarkets.treasury.redeemIntermediate")}
          onClick={() => onWithdraw(position, "intermediate")}
          size="sm"
          type="button"
          variant="outline"
        >
          <span className="@2xl:hidden">
            {t("DashboardMarkets.treasury.redeemIntermediateShort")}
          </span>
          <span className="hidden @2xl:inline">
            {t("DashboardMarkets.treasury.redeemIntermediate")}
          </span>
        </Button>
      ) : null}
      {holdsShares ? (
        <Button
          data-earn-vault-withdraw-focus-fallback={position.id}
          onClick={() => onWithdraw(position)}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("DashboardMarkets.treasury.withdraw")}
        </Button>
      ) : null}
    </div>
  );
}

function TreasuryPositions({
  balanceOf,
  deposits,
  failed,
  isLoading,
  onWithdraw,
  positions,
  unrecordedShareMints,
  wallets,
  withdrawals,
}: {
  balanceOf: (position: EarnVaultPosition) => TreasuryPositionBalance;
  deposits: readonly TrackedVaultDeposit[];
  failed: boolean;
  isLoading: boolean;
  onWithdraw: (position: EarnVaultPosition, parSource?: EarnVaultParRedemptionSource) => void;
  positions: readonly EarnVaultPosition[] | undefined;
  unrecordedShareMints: ReadonlySet<string> | undefined;
  wallets: readonly EarnFundingWallet[];
  withdrawals: readonly TrackedVaultWithdrawal[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  // Newest first until the reader sorts: a balance that changes under an action must not move
  // its row.
  const [balanceSort, setBalanceSort] = useState<NumericSortState>("none");
  const activities = useMemo(() => vaultActivities(deposits, withdrawals), [deposits, withdrawals]);
  const latestActivityByPositionId = useMemo(
    () => latestVaultActivityByPosition(activities),
    [activities]
  );
  const activePositions = useMemo(() => {
    const listed = displayedVaultPositions(positions, deposits).filter(
      (position) => isOpenVaultPosition(position) || balanceOf(position).syncing
    );
    return balanceSort === "none"
      ? listed
      : sortByOptionalDecimal(
          listed,
          (position) => knownWireDecimal(balanceOf(position).value),
          balanceSort
        );
  }, [balanceOf, balanceSort, deposits, positions]);
  const walletById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.id, wallet] as const)),
    [wallets]
  );

  // An empty or failed list sits in the middle of the rows' footprint.
  const centered = !isLoading && activePositions.length === 0;
  let body: ReactNode;
  if (isLoading) {
    body = <EarnTableSkeleton columns={TREASURY_POSITION_COLUMNS} rows={2} />;
  } else if (failed && activePositions.length === 0) {
    body = (
      <ListEmptyState
        description={t("DashboardMarkets.treasury.vaultPositionsErrorDescription")}
        message={t("DashboardMarkets.treasury.vaultPositionsErrorTitle")}
      />
    );
  } else if (activePositions.length === 0) {
    // "No positions" is a claim of ABSENCE, so it needs the same witness every other surface
    // needs. Receipt tokens with no row behind them, or a witness that could not be built,
    // mean holdings may exist that this list cannot show.
    body =
      unrecordedShareMints === undefined || unrecordedShareMints.size > 0 ? (
        <ListEmptyState
          description={t("DashboardMarkets.treasury.vaultPositionsIncompleteDescription")}
          message={t("DashboardMarkets.treasury.vaultPositionsIncompleteTitle")}
        />
      ) : (
        <ListEmptyState
          description={t("DashboardMarkets.treasury.vaultPositionsEmptyDescription")}
          message={t("DashboardMarkets.treasury.vaultPositionsEmptyTitle")}
        />
      );
  } else {
    body = (
      <div className={EARN_TABLE_FRAME}>
        <Table className={EARN_TABLE} data-treasury-table="positions">
          <TableHeader>
            <TableRow>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_POSITION_COLUMNS.position)}>
                {t("DashboardMarkets.treasury.position")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_POSITION_COLUMNS.wallet)}>
                {t("DashboardMarkets.treasury.custodyWallet")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_POSITION_COLUMNS.status)}>
                {t("DashboardMarkets.treasury.positionStatus")}
              </TableHead>
              <SortableNumericTableHead
                className={TREASURY_POSITION_COLUMNS.balance}
                direction={balanceSort}
                onToggle={() =>
                  setBalanceSort((current) =>
                    current === "descending" ? "ascending" : "descending"
                  )
                }
              >
                {t("DashboardMarkets.treasury.balance")}
              </SortableNumericTableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_POSITION_COLUMNS.actions)}>
                <span className="sr-only">{t("DashboardMarkets.treasury.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activePositions.map((position) => {
              const asset = earnMintAsset(position.tokenMint);
              const wallet = walletById.get(position.custodyWalletId);
              const balance = balanceOf(position);
              const status = vaultPositionStatus(latestActivityByPositionId.get(position.id));
              return (
                <TableRow key={position.id}>
                  <TableCell
                    className={cn(PAYMENTS_TABLE_CELL, TREASURY_POSITION_COLUMNS.position)}
                  >
                    <EarnRowIdentity
                      asset={asset}
                      detail={earnDetailLine([earnProviderLabel(position.provider), asset.symbol])}
                      name={positionDisplayName(position)}
                    />
                  </TableCell>
                  <TableCell
                    className={cn(
                      PAYMENTS_TABLE_CELL,
                      TREASURY_POSITION_COLUMNS.wallet,
                      "truncate text-secondary"
                    )}
                  >
                    {wallet?.label?.trim() ||
                      shortenMarketAddress(wallet?.publicKey ?? position.custodyWalletId)}
                  </TableCell>
                  <TableCell className={cn(PAYMENTS_TABLE_CELL, TREASURY_POSITION_COLUMNS.status)}>
                    <TreasuryPositionStatus status={status} />
                  </TableCell>
                  <TreasuryPositionBalanceCell
                    formattedBalance={formatTokenValue(balance.value, position.tokenMint, locale)}
                    lastVerifiedAt={balance.lastVerifiedAt}
                    parIntermediate={position.parIntermediate}
                    status={status}
                    syncing={balance.syncing}
                  />
                  <TableCell className={cn(PAYMENTS_TABLE_CELL, TREASURY_POSITION_COLUMNS.actions)}>
                    <TreasuryPositionActions onWithdraw={onWithdraw} position={position} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <RecordBlock title={t("DashboardMarkets.treasury.vaultPositionsTitle")}>
      <div className={cn(TREASURY_POSITIONS_BODY, centered && "justify-center")}>{body}</div>
    </RecordBlock>
  );
}

function KaminoAllocationsTooltipContent({
  allocations,
  locale,
}: {
  allocations: KaminoVaultAllocations;
  locale: string;
}) {
  const t = useTranslations();
  const rows = kaminoDisclosureRows(allocations);
  const asOfLabel = formatKaminoAsOf(allocations.asOf, locale);

  return (
    <>
      {/* Two columns in a FIXED layout inside the tooltip's fixed width: the market column
      truncates on its child span (never the cell, see CLAUDE.md), the weight column is sized
      for "100.0%" and never wraps, so no market name or figure can run past the tooltip's
      edge. The caption names the table for assistive technology; the trigger's own summary is
      the visible title. */}
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">{t("DashboardMarkets.treasury.allocationsTitle")}</caption>
        <colgroup>
          <col />
          <col className="w-16" />
        </colgroup>
        <thead>
          <tr className="text-tertiary">
            <th className="pb-1.5 text-left font-normal" scope="col">
              {t("DashboardMarkets.treasury.allocationsMarket")}
            </th>
            <th className="pb-1.5 text-right font-normal" scope="col">
              {t("DashboardMarkets.treasury.allocationsAllocation")}
            </th>
          </tr>
        </thead>
        <tbody className="border-t border-border-subtle">
          {rows.map((row) =>
            row.kind === "market" ? (
              <tr key={row.reserve}>
                <td className="pt-1.5 pe-4">
                  <span className="block truncate" title={row.marketName}>
                    {kaminoMarketLabel(row.marketName)}
                  </span>
                </td>
                <td className="whitespace-nowrap pt-1.5 text-right tabular-nums">
                  {formatAllocationWeight(row.pct, locale)}
                </td>
              </tr>
            ) : (
              <tr className="text-tertiary" key="idle">
                <td className="pt-1.5 pe-4">
                  <span className="block truncate">
                    {t("DashboardMarkets.treasury.allocationsIdle")}
                  </span>
                </td>
                <td className="whitespace-nowrap pt-1.5 text-right tabular-nums">
                  {formatAllocationWeight(row.pct, locale)}
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
      {asOfLabel ? (
        <span className="mt-2 block truncate text-tertiary">
          {t("DashboardMarkets.treasury.allocationsAsOf", { date: asOfLabel })}
        </span>
      ) : null}
    </>
  );
}

/**
 * How a Kamino vault's capital is deployed, as the last part of its row's detail line: the
 * deployed weight, with the vault's own allocations on hover and focus, from the table's one
 * read. Other providers, and devnet vaults Kamino's mainnet-only source cannot describe, add
 * nothing and are never part of that read. A later failed read keeps the last disclosure rather
 * than blanking it.
 */
function StrategyAllocations({
  allocationsRead,
  strategy,
}: {
  allocationsRead: KaminoVaultAllocationsRead;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const vaultAddress = kaminoAllocationsVault(strategy);
  const allocations =
    vaultAddress === undefined ? undefined : allocationsRead.allocationsByVault?.[vaultAddress];
  if (!allocations || !hasKaminoAllocationContent(allocations)) return null;

  const deployedPct = kaminoDeployedWeightPct(allocations.unallocated?.pct);
  // A missing unallocated share only hides the SUMMARY weight; the per-reserve
  // rows in the disclosure are still a real read worth disclosing.
  const summaryLabel =
    deployedPct !== undefined
      ? t("DashboardMarkets.treasury.allocationsSummary", {
          weight: formatAllocationWeight(deployedPct, locale),
        })
      : t("DashboardMarkets.treasury.allocationsSummaryUnavailable");

  // A phone's detail line has room for the provider alone.
  return (
    <span className="hidden @2xl:inline">
      {" · "}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="inline-flex items-center gap-1 rounded-sm align-bottom text-tertiary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
              type="button"
            >
              <span className={deployedPct !== undefined ? "tabular-nums" : undefined}>
                {summaryLabel}
              </span>
              <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="w-64 text-xs leading-5">
            <KaminoAllocationsTooltipContent allocations={allocations} locale={locale} />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

/**
 * A strategy row's way in: Deposit where this project can fund it, otherwise the reason it
 * cannot, as words. A Sandbox project browses Mainnet vaults without funding them.
 */
function StrategyAction({
  environment,
  onDeposit,
  providerAccess,
  strategy,
}: {
  environment: SdpEnvironment;
  onDeposit: (strategy: EarnStrategy) => void;
  providerAccess: EarnProviderAccess | null;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  // A read-only member (`viewer`) sees the shelf but no way in, which the API refuses them.
  const canWrite = useCanWrite();
  if (!canWrite) return null;
  const availability = earnVaultDepositAvailability(strategy, environment, providerAccess);
  const sandboxMainnet = environment === "sandbox" && strategy.hostCluster === "mainnet-beta";
  if (availability === "available" && !sandboxMainnet) {
    return (
      <Button onClick={() => onDeposit(strategy)} size="sm" type="button" variant="outline">
        {t("DashboardMarkets.treasury.deposit")}
      </Button>
    );
  }
  const reason = sandboxMainnet
    ? t("DashboardMarkets.treasury.clusterUnavailable", {
        cluster: SOLANA_CLUSTER_LABELS["mainnet-beta"],
      })
    : earnDepositAvailabilityLabel(availability, TREASURY_AVAILABILITY_LABELS, strategy, t);
  // The reason wraps rather than truncates: on a phone its column is too narrow for two words.
  return (
    <span className="inline-flex max-w-full items-center justify-end gap-1.5 text-tertiary">
      <span className="min-w-0 whitespace-normal text-right" data-treasury-deposit-unavailable>
        {reason}
      </span>
      {sandboxMainnet ? (
        <InfoHint
          className="shrink-0"
          text={t("DashboardMarkets.treasury.mainnetDepositUnavailable")}
        />
      ) : null}
    </span>
  );
}

function StrategyTable({
  environment,
  kaminoAllocations,
  onDeposit,
  positions,
  providerAccess,
  strategies,
  unrecordedShareMints,
}: {
  environment: SdpEnvironment;
  kaminoAllocations: KaminoVaultAllocationsRead;
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
      strategySort.field === "apy"
        ? (strategy) => knownWireDecimal(strategy.currentApy)
        : (strategy) => knownWireDecimal(strategyTvlUsd(strategy)),
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
    <div className={EARN_TABLE_FRAME}>
      <Table className={EARN_TABLE} data-treasury-table="strategies">
        <TableHeader>
          <TableRow>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_STRATEGY_COLUMNS.strategy)}>
              {t("DashboardMarkets.treasury.strategy")}
            </TableHead>
            <SortableNumericTableHead
              className={TREASURY_STRATEGY_COLUMNS.apy}
              direction={strategySort.field === "apy" ? strategySort.direction : "none"}
              onToggle={() => toggleStrategySort("apy")}
            >
              {t("DashboardMarkets.treasury.apy")}
            </SortableNumericTableHead>
            <SortableNumericTableHead
              className={TREASURY_STRATEGY_COLUMNS.tvl}
              direction={strategySort.field === "tvl" ? strategySort.direction : "none"}
              onToggle={() => toggleStrategySort("tvl")}
            >
              {t("DashboardMarkets.treasury.tvl")}
            </SortableNumericTableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_STRATEGY_COLUMNS.position)}>
              {t("DashboardMarkets.treasury.yourPosition")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_STRATEGY_COLUMNS.actions)}>
              <span className="sr-only">{t("DashboardMarkets.treasury.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedStrategies.map((strategy) => {
            const asset = earnStrategyAsset(strategy);
            const position = positions
              ? strategyPositionValue(strategy, positions, unrecordedShareMints)
              : null;
            const positionUnavailable =
              position === null ||
              position.unrecorded === true ||
              (position.count > 0 && position.value === undefined);
            return (
              <TableRow key={strategy.id}>
                <TableCell className={cn(PAYMENTS_TABLE_CELL, TREASURY_STRATEGY_COLUMNS.strategy)}>
                  <EarnRowIdentity
                    asset={asset}
                    detail={
                      <>
                        {earnDetailLine([
                          earnProviderLabel(strategy.provider),
                          ...(strategy.hostCluster === "devnet"
                            ? [SOLANA_CLUSTER_LABELS.devnet]
                            : []),
                        ])}
                        <StrategyAllocations
                          allocationsRead={kaminoAllocations}
                          strategy={strategy}
                        />
                      </>
                    }
                    name={strategy.name}
                  />
                </TableCell>
                <TableCell
                  className={cn(
                    PAYMENTS_TABLE_CELL,
                    TREASURY_STRATEGY_COLUMNS.apy,
                    "text-primary tabular-nums"
                  )}
                >
                  {formatProviderApy(strategy.currentApy, locale)}
                </TableCell>
                <TableCell
                  className={cn(
                    PAYMENTS_TABLE_CELL,
                    TREASURY_STRATEGY_COLUMNS.tvl,
                    "text-primary tabular-nums"
                  )}
                >
                  {formatUsd(strategyTvlUsd(strategy), locale)}
                </TableCell>
                <TableCell
                  className={cn(
                    PAYMENTS_TABLE_CELL,
                    TREASURY_STRATEGY_COLUMNS.position,
                    "text-primary tabular-nums"
                  )}
                >
                  {position === null || position.unrecorded || position.count === 0
                    ? "—"
                    : asset
                      ? formatTokenValue(position.value, asset.mint, locale)
                      : formatProviderAmount(position.value, locale)}
                  {positionUnavailable ? (
                    <span className="block truncate text-tertiary">
                      {t("DashboardMarkets.treasury.positionValueUnavailable")}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className={cn(PAYMENTS_TABLE_CELL, TREASURY_STRATEGY_COLUMNS.actions)}>
                  <StrategyAction
                    environment={environment}
                    onDeposit={onDeposit}
                    providerAccess={providerAccess}
                    strategy={strategy}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

type CatalogueShelf = "devnet" | "mainnet";

/**
 * One Sandbox shelf that failed while the other still has rows: said above them, since either
 * shelf can fail on its own without taking the other's rows off the screen. A shelf still
 * loading only turns the Refresh mark; the rows already there stay put.
 */
function CatalogueShelfError({ shelf }: { shelf: CatalogueShelf }) {
  const t = useTranslations();
  return (
    <Callout live variant="warning">
      {shelf === "devnet"
        ? t("DashboardMarkets.treasury.devnetStrategiesUnavailable")
        : t("DashboardMarkets.treasury.mainnetStrategiesUnavailable")}
    </Callout>
  );
}

interface TreasuryStrategiesProps {
  devnetFailed: boolean;
  devnetLoading: boolean;
  environment: SdpEnvironment;
  failed: boolean;
  isLoading: boolean;
  /** The Information detail's one table-wide read, owned by the container. */
  kaminoAllocations: KaminoVaultAllocationsRead;
  mainnetFailed: boolean;
  mainnetLoading: boolean;
  onDeposit: (strategy: EarnStrategy) => void;
  onRefresh: () => void;
  positions: readonly EarnVaultPosition[] | undefined;
  providerAccess: EarnProviderAccess | null;
  strategies: readonly EarnStrategy[] | undefined;
  unrecordedShareMints: ReadonlySet<string> | undefined;
}

/** The shelf's rows, or what stands in for them while they load, fail or come back empty. */
function StrategiesBody({
  devnetFailed,
  environment,
  failed,
  isLoading,
  kaminoAllocations,
  mainnetFailed,
  onDeposit,
  positions,
  providerAccess,
  strategies,
  unrecordedShareMints,
}: Omit<TreasuryStrategiesProps, "devnetLoading" | "mainnetLoading" | "onRefresh">) {
  const t = useTranslations();
  if (isLoading) return <EarnTableSkeleton columns={TREASURY_STRATEGY_COLUMNS} rows={4} />;
  if (failed) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.treasury.strategiesErrorDescription")}
        message={t("DashboardMarkets.treasury.strategiesErrorTitle")}
      />
    );
  }
  if (strategies === undefined || strategies.length === 0) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.treasury.strategiesEmptyDescription")}
        message={t("DashboardMarkets.treasury.strategiesEmptyTitle")}
      />
    );
  }
  return (
    <>
      {mainnetFailed ? <CatalogueShelfError shelf="mainnet" /> : null}
      {devnetFailed ? <CatalogueShelfError shelf="devnet" /> : null}
      <StrategyTable
        environment={environment}
        kaminoAllocations={kaminoAllocations}
        onDeposit={onDeposit}
        positions={positions}
        providerAccess={providerAccess}
        strategies={strategies}
        unrecordedShareMints={unrecordedShareMints}
      />
    </>
  );
}

/** The shelf's refresh, and while a second shelf still loads, a quiet status naming which. */
function StrategiesRefresh({
  mainnetLoading,
  onRefresh,
  shelfLoading,
}: {
  mainnetLoading: boolean;
  onRefresh: () => void;
  shelfLoading: boolean;
}) {
  const t = useTranslations();
  return (
    <>
      {shelfLoading ? (
        <span className="sr-only" role="status">
          {t(
            mainnetLoading
              ? "DashboardMarkets.treasury.mainnetStrategiesLoading"
              : "DashboardMarkets.treasury.devnetStrategiesLoading"
          )}
        </span>
      ) : null}
      <Button
        iconLeft={
          <RefreshCwIcon
            aria-hidden="true"
            className={cn("size-4", shelfLoading && "motion-safe:animate-spin")}
          />
        }
        onClick={onRefresh}
        size="sm"
        type="button"
        variant="ghost"
      >
        {t("DashboardMarkets.treasury.refresh")}
      </Button>
    </>
  );
}

function TreasuryStrategies({
  devnetFailed,
  devnetLoading,
  environment,
  failed,
  isLoading,
  kaminoAllocations,
  mainnetFailed,
  mainnetLoading,
  onDeposit,
  onRefresh,
  positions,
  providerAccess,
  strategies,
  unrecordedShareMints,
}: TreasuryStrategiesProps) {
  const t = useTranslations();
  const depositsEnabled = SURFACED_VAULT_DIRECT_EARN_PROVIDERS.some((provider) =>
    isVaultDirectDepositEnabled(environment, provider)
  );
  const hasRows = !isLoading && !failed && strategies !== undefined && strategies.length > 0;

  return (
    <RecordBlock
      aside={
        <StrategiesRefresh
          mainnetLoading={mainnetLoading}
          onRefresh={onRefresh}
          shelfLoading={hasRows && (mainnetLoading || devnetLoading)}
        />
      }
      hint={t(treasuryStrategiesDisclosureKey(depositsEnabled, providerAccess))}
      title={t("DashboardMarkets.treasury.strategiesTitle")}
    >
      {/* A failed or empty shelf sits in the middle of the four rows it replaces. */}
      <div className={cn(TREASURY_STRATEGIES_BODY, !isLoading && !hasRows && "justify-center")}>
        <StrategiesBody
          devnetFailed={devnetFailed}
          environment={environment}
          failed={failed}
          isLoading={isLoading}
          kaminoAllocations={kaminoAllocations}
          mainnetFailed={mainnetFailed}
          onDeposit={onDeposit}
          positions={positions}
          providerAccess={providerAccess}
          strategies={strategies}
          unrecordedShareMints={unrecordedShareMints}
        />
      </div>
    </RecordBlock>
  );
}

/**
 * A custodial program's way out. An open provider id may outlive its runtime capability, so the
 * withdrawal form opens only where the shared contract declares a Solana payout lane, and the row
 * says why otherwise. A read-only member (`viewer`) gets neither, which the API refuses them.
 */
function TreasuryProgramAction({
  onWithdraw,
  program,
}: {
  onWithdraw: (program: EarnProgram) => void;
  program: EarnProgram;
}) {
  const t = useTranslations();
  const canWrite = useCanWrite();
  if (!canWrite) return null;
  if (earnProgramSolanaPayoutTokens(program.provider).length === 0) {
    // The reason wraps rather than truncates: it stands in for the action, so it reads whole.
    return (
      <span className="block whitespace-normal text-pretty text-tertiary">
        {t("DashboardMarkets.treasury.providerWithdrawalUnavailable")}
      </span>
    );
  }
  return (
    <Button
      data-earn-withdraw-focus-fallback={program.id}
      disabled={program.wallet.status === "creating"}
      onClick={() => onWithdraw(program)}
      size="sm"
      type="button"
      variant="outline"
    >
      {t("DashboardMarkets.treasury.withdraw")}
    </Button>
  );
}

/** Organization-wide custodial programs: listed and withdrawable after their provider closes. */
function TreasuryPrograms({
  isLoading,
  onWithdraw,
  programs,
  unavailable,
}: {
  isLoading: boolean;
  onWithdraw: (program: EarnProgram) => void;
  programs: readonly EarnProgram[];
  unavailable: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  // Most organizations hold none, so nothing stands in while the list loads: a placeholder
  // that then disappears would shift the page. The section closes the page, so arriving late
  // moves nothing.
  if (isLoading || (!unavailable && programs.length === 0)) return null;

  let body: ReactNode;
  if (unavailable) {
    body = (
      <p className="text-body text-secondary">
        {t("DashboardMarkets.treasury.existingProgramsUnavailable")}
      </p>
    );
  } else {
    body = (
      <>
        <div className={EARN_TABLE_FRAME}>
          <Table className={EARN_TABLE} data-treasury-table="programs">
            <TableHeader>
              <TableRow>
                <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_PROGRAM_COLUMNS.program)}>
                  {t("DashboardMarkets.treasury.strategy")}
                </TableHead>
                <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_PROGRAM_COLUMNS.status)}>
                  {t("DashboardMarkets.treasury.status")}
                </TableHead>
                <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_PROGRAM_COLUMNS.balance)}>
                  {t("DashboardMarkets.treasury.balance")}
                </TableHead>
                <TableHead className={cn(PAYMENTS_TABLE_HEAD, TREASURY_PROGRAM_COLUMNS.actions)}>
                  <span className="sr-only">{t("DashboardMarkets.treasury.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {programs.map((program) => {
                const status = PROGRAM_STATUS_DISPLAY[program.wallet.status];
                return (
                  <TableRow key={program.id}>
                    <TableCell
                      className={cn(PAYMENTS_TABLE_CELL, TREASURY_PROGRAM_COLUMNS.program)}
                    >
                      <EarnRowIdentity
                        detail={earnProviderLabel(program.provider)}
                        name={programName(program, t("DashboardMarkets.treasury.unnamedProgram"))}
                      />
                    </TableCell>
                    <TableCell className={cn(PAYMENTS_TABLE_CELL, TREASURY_PROGRAM_COLUMNS.status)}>
                      <StatusText className="block truncate" tone={status.tone}>
                        {t(status.labelKey)}
                      </StatusText>
                    </TableCell>
                    <TableCell
                      className={cn(
                        PAYMENTS_TABLE_CELL,
                        TREASURY_PROGRAM_COLUMNS.balance,
                        "text-primary tabular-nums"
                      )}
                    >
                      {formatUsd(program.wallet.balance.totalUsd, locale)}
                      {/* On a phone the status column drops out and its word reads here. */}
                      <StatusText className="block truncate @2xl:hidden" tone={status.tone}>
                        {t(status.labelKey)}
                      </StatusText>
                    </TableCell>
                    <TableCell
                      className={cn(PAYMENTS_TABLE_CELL, TREASURY_PROGRAM_COLUMNS.actions)}
                    >
                      <TreasuryProgramAction onWithdraw={onWithdraw} program={program} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {/* A provider can require customer-side approval, but SDP has no provider-approval
            route or signer UI yet. Never imply the dashboard can release a withdrawal that is
            parked there. */}
        <Callout variant="neutral">
          {t("DashboardMarkets.treasury.withdrawalApprovalUnavailable")}
        </Callout>
      </>
    );
  }

  return (
    <RecordBlock
      hint={t("DashboardMarkets.treasury.existingProgramsDescription")}
      title={t("DashboardMarkets.treasury.existingProgramsTitle")}
    >
      {body}
    </RecordBlock>
  );
}

export interface TreasuryWorkspaceContentProps {
  activeWallets: readonly EarnFundingWallet[];
  allocation: TreasuryAllocation;
  catalogueFailed: boolean;
  catalogueLoading: boolean;
  catalogueStrategies: readonly EarnStrategy[] | undefined;
  devnetCatalogueFailed: boolean;
  devnetCatalogueLoading: boolean;
  environment: SdpEnvironment;
  kaminoAllocations: KaminoVaultAllocationsRead;
  mainnetCatalogueFailed: boolean;
  mainnetCatalogueLoading: boolean;
  onDeposit: (strategy: EarnStrategy) => void;
  /** A queued request settled: re-read holdings and cash, nothing else. */
  onHoldingsChanged: () => void;
  onRefresh: () => void;
  onWithdrawPosition: (
    position: EarnVaultPosition,
    parSource?: EarnVaultParRedemptionSource
  ) => void;
  onWithdrawProgram: (program: EarnProgram) => void;
  portfolioApy: string | undefined;
  positions: readonly EarnVaultPosition[] | undefined;
  positionsFailed: boolean;
  positionsLoading: boolean;
  balanceOf: (position: EarnVaultPosition) => TreasuryPositionBalance;
  programs: readonly EarnProgram[];
  programsLoading: boolean;
  programsUnavailable: boolean;
  providerAccess: EarnProviderAccess | null;
  summaryLoading: boolean;
  balancesRefreshing: boolean;
  vaultDeposits: readonly TrackedVaultDeposit[];
  vaultWithdrawals: readonly TrackedVaultWithdrawal[];
  walletsFailed: boolean;
  walletsLoading: boolean;
}

/**
 * Treasury's page, in the page column the shell titles: the summary, the custody wallets that
 * fund it, the open positions, any queued withdrawals, the strategies to deposit into, and any
 * custodial programs still held.
 */
export function TreasuryWorkspaceContent({
  activeWallets,
  allocation,
  catalogueFailed,
  catalogueLoading,
  catalogueStrategies,
  devnetCatalogueFailed,
  devnetCatalogueLoading,
  environment,
  kaminoAllocations,
  mainnetCatalogueFailed,
  mainnetCatalogueLoading,
  onDeposit,
  onHoldingsChanged,
  onRefresh,
  onWithdrawPosition,
  onWithdrawProgram,
  portfolioApy,
  positions,
  positionsFailed,
  positionsLoading,
  balanceOf,
  programs,
  programsLoading,
  programsUnavailable,
  providerAccess,
  summaryLoading,
  balancesRefreshing,
  vaultDeposits,
  vaultWithdrawals,
  walletsFailed,
  walletsLoading,
}: TreasuryWorkspaceContentProps) {
  return (
    <RecordStack>
      <TreasurySummary
        allocation={allocation}
        estimatedApy={portfolioApy}
        isLoading={summaryLoading}
        refreshing={balancesRefreshing}
      />
      <TreasuryWallets
        allocation={allocation}
        failed={walletsFailed}
        isLoading={walletsLoading}
        refreshing={balancesRefreshing}
        wallets={activeWallets}
      />
      <TreasuryPositions
        balanceOf={balanceOf}
        deposits={vaultDeposits}
        failed={positionsFailed}
        isLoading={positionsLoading}
        onWithdraw={onWithdrawPosition}
        positions={positions}
        unrecordedShareMints={allocation.unrecordedShareMints}
        wallets={activeWallets}
        withdrawals={vaultWithdrawals}
      />
      <EarnVaultWithdrawalRequestsCard onChanged={onHoldingsChanged} />
      <TreasuryStrategies
        devnetFailed={devnetCatalogueFailed}
        devnetLoading={devnetCatalogueLoading}
        environment={environment}
        failed={catalogueFailed}
        isLoading={catalogueLoading}
        kaminoAllocations={kaminoAllocations}
        mainnetFailed={mainnetCatalogueFailed}
        mainnetLoading={mainnetCatalogueLoading}
        onDeposit={onDeposit}
        onRefresh={onRefresh}
        positions={positionsFailed ? undefined : positions}
        providerAccess={providerAccess}
        strategies={catalogueStrategies}
        unrecordedShareMints={allocation.unrecordedShareMints}
      />
      <TreasuryPrograms
        isLoading={programsLoading}
        onWithdraw={onWithdrawProgram}
        programs={programs}
        unavailable={programsUnavailable}
      />
    </RecordStack>
  );
}
