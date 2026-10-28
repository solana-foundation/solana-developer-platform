"use client";

import type {
  EarnExternalWalletPosition,
  EarnExternalWalletPositionSummary,
  EarnExternalWalletStrategyTotal,
  EarnStrategy,
} from "@sdp/types/earn";
import { type SolanaCluster, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { cn } from "@sdp/ui/cn";
import { HeightReveal } from "@sdp/ui/height-reveal";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { StatusText } from "@sdp/ui/status-text";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import { ChevronRightIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import Link from "next/link";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { EmbeddedYieldPortfolioSkeleton } from "@/app/dashboard/[projectId]/markets/markets-route-skeletons";
import { truncateMiddle } from "@/app/dashboard/[projectId]/markets/truncate-middle";
import {
  PAYMENTS_TABLE_CELL,
  PAYMENTS_TABLE_HEAD,
} from "@/app/dashboard/[projectId]/payments/payments-table";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { RecordBlock, RecordStack } from "@/components/refresh-record";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerAddressUrl } from "@/lib/explorer";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { isPositiveDecimal } from "./earn-decimal";
import {
  earnDetailLine,
  earnProviderLabel,
  earnStrategyLiquidityLabel,
  formatEpochSeconds,
  formatProviderAmount,
  formatTokenValue,
  formatUsd,
} from "./earn-format";
import {
  earnMintAsset,
  earnStrategyReferenceKey,
  sumDecimalStrings,
} from "./earn-market-presentation";
import { EarnRowIdentity, EarnSummary } from "./earn-page-blocks";
import { useEarnExternalWalletPositionSummary, useEarnStrategies } from "./earn-program-data";
import { EARN_TABLE, EARN_TABLE_FRAME } from "./earn-table-layout";
import { earnVaultHoldingValue } from "./earn-vault-holding";
import {
  EMBEDDED_YIELD_STRATEGY_COLUMNS as COLUMNS,
  EMBEDDED_YIELD_WALLET_GRID,
} from "./embedded-yield-layout";

/** Each count in the summary's stat line, worded for one and for several, as Payments words its census. */
const SUMMARY_COUNT_WORDS = {
  wallets: {
    one: "DashboardMarkets.earnProgram.summaryWallets.one",
    other: "DashboardMarkets.earnProgram.summaryWallets.other",
  },
  positions: {
    one: "DashboardMarkets.earnProgram.summaryPositions.one",
    other: "DashboardMarkets.earnProgram.summaryPositions.other",
  },
  assets: {
    one: "DashboardMarkets.earnProgram.summaryAssets.one",
    other: "DashboardMarkets.earnProgram.summaryAssets.other",
  },
} as const satisfies Record<string, Record<"one" | "other", MessageKey>>;

const LAST_DEPOSIT_FORMAT = {
  dateStyle: "long",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

/**
 * What the portfolio is worth in dollars. Every Earn deposit token is a USD stablecoin, so each
 * token's total is a dollar figure at par and the totals add. The sum is withheld while any
 * position's live value is unread, since a partial total reads as a loss, and when a token has no
 * dollar value at par, whose units cannot be added to dollars.
 */
type PortfolioLiveValue =
  | { kind: "value"; value: string }
  | { kind: "withheld" }
  | { kind: "not_dollar" };

/** Why the hero shows no figure, for each answer `portfolioLiveValue` gives. */
const LIVE_VALUE_HINTS = {
  value: undefined,
  withheld: "DashboardMarkets.earnProgram.liveValueWithheld",
  not_dollar: "DashboardMarkets.earnProgram.liveValueNotDollar",
} as const satisfies Record<PortfolioLiveValue["kind"], MessageKey | undefined>;

function portfolioLiveValue(summary: EarnExternalWalletPositionSummary): PortfolioLiveValue {
  if (summary.unavailablePositionCount > 0) return { kind: "withheld" };
  const values: string[] = [];
  for (const total of summary.totalsByToken) {
    if (total.tokenValue === undefined) return { kind: "withheld" };
    if (!WELL_KNOWN_TOKEN_BY_MINT.get(total.tokenMint)?.isUsdStable) return { kind: "not_dollar" };
    values.push(total.tokenValue);
  }
  const value = sumDecimalStrings(values);
  return value === undefined ? { kind: "withheld" } : { kind: "value", value };
}

function formatLatestDepositDate(
  positions: readonly EarnExternalWalletPosition[] | undefined,
  locale: string
): string {
  if (positions === undefined) return "—";
  const latest = positions.reduce<number | undefined>((current, position) => {
    const createdAt = Date.parse(position.createdAt);
    if (!Number.isFinite(createdAt)) return current;
    return current === undefined || createdAt > current ? createdAt : current;
  }, undefined);
  if (latest === undefined) return "—";
  return new Intl.DateTimeFormat(locale, LAST_DEPOSIT_FORMAT).format(latest);
}

/** The portfolio's live value, then how many customers, positions and assets make it up. */
function PortfolioSummary({ summary }: { summary: EarnExternalWalletPositionSummary }) {
  const t = useTranslations();
  const locale = useLocale();
  const countFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const liveValue = portfolioLiveValue(summary);
  const hintKey = LIVE_VALUE_HINTS[liveValue.kind];
  const counts = [
    { id: "wallets", count: summary.walletCount },
    { id: "positions", count: summary.positionCount },
    { id: "assets", count: summary.totalsByToken.length },
  ] as const;

  return (
    <EarnSummary
      figure={liveValue.kind === "value" ? formatUsd(liveValue.value, locale) : "—"}
      hint={hintKey === undefined ? undefined : t(hintKey)}
      label={t("DashboardMarkets.earnProgram.liveValue")}
      stats={counts.map(({ count, id }) => ({
        id,
        label: t(SUMMARY_COUNT_WORDS[id][count === 1 ? "one" : "other"]),
        value: countFormat.format(count),
      }))}
    />
  );
}

/**
 * Notices about the figures on the page. The region stays mounted, empty, so a refresh that fails
 * later is announced as it happens; a portfolio with unread values says so from the start.
 */
function PortfolioNotices({
  refreshFailed,
  unavailablePositionCount,
}: {
  refreshFailed: boolean;
  unavailablePositionCount: number;
}) {
  const t = useTranslations();
  return (
    <>
      <div aria-atomic="true" className={refreshFailed ? undefined : "sr-only"} role="status">
        {refreshFailed ? (
          <Callout variant="warning">
            {t("DashboardMarkets.earnProgram.portfolioRefreshError")}
          </Callout>
        ) : null}
      </div>
      {unavailablePositionCount > 0 ? (
        <Callout variant="warning">
          {t("DashboardMarkets.earnProgram.incompletePortfolio", {
            count: unavailablePositionCount,
          })}
        </Callout>
      ) : null}
    </>
  );
}

function CustomerWallet({
  cluster,
  position,
}: {
  cluster: SolanaCluster;
  position: EarnExternalWalletPosition;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const asset = earnMintAsset(position.tokenMint);
  const holdingValue = earnVaultHoldingValue(position);
  const unlockTime = formatEpochSeconds(position.unlockTimestamp, locale);
  const shares = position.withdrawableShares ?? position.shares;
  // Absent means the provider read failed, not locked: coercing it to zero would show an
  // unlock date the data never claimed.
  const locked =
    unlockTime !== undefined &&
    position.withdrawableShares !== undefined &&
    !isPositiveDecimal(position.withdrawableShares);

  // The address indents past the strategy's token mark to its name; the value sits in the live
  // value's track, at a cell's padding.
  return (
    <article className={cn(EMBEDDED_YIELD_WALLET_GRID, "items-center py-2.5")}>
      <div className="min-w-0 ps-12 pe-[var(--table-cell-padding-x)]">
        <div className="flex h-5 min-w-0 items-center gap-1">
          <span className="truncate text-primary" title={position.ownerAddress}>
            {truncateMiddle(position.ownerAddress, 5, 5)}
          </span>
          <button
            aria-label={t("DashboardMarkets.earnProgram.copyWalletAddress")}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
            onClick={() => void navigator.clipboard.writeText(position.ownerAddress)}
            type="button"
          >
            <CopyIcon aria-hidden="true" className="size-3.5" />
          </button>
          <a
            aria-label={t("DashboardMarkets.earnProgram.openWalletInExplorer")}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
            href={explorerAddressUrl(position.ownerAddress, cluster)}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          </a>
        </div>
        {/* Wraps rather than truncates: on a phone a long share count would run into the value. */}
        <p className="flex min-w-0 flex-wrap gap-x-1 text-tertiary">
          <span>{t("DashboardMarkets.earnProgram.availableShares")}</span>
          <span className="tabular-nums">
            {shares ?? t("DashboardMarkets.earnProgram.valueUnavailable")}
          </span>
          {locked ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("DashboardMarkets.earnProgram.sharesUnlockAt", { time: unlockTime })}</span>
            </>
          ) : null}
        </p>
      </div>
      <div className="col-start-2 px-[var(--table-cell-padding-x)] text-right @2xl:col-start-3">
        <div className="flex h-5 items-center justify-end tabular-nums">
          {holdingValue === undefined ? (
            <StatusText tone="attention">
              {t("DashboardMarkets.earnProgram.valueUnavailable")}
            </StatusText>
          ) : (
            <span className="text-primary">
              {formatTokenValue(holdingValue, asset.mint, locale)}
            </span>
          )}
        </div>
        {position.parIntermediate ? (
          <p className="text-tertiary">
            {t("DashboardEarn.parRedemption.positionIntermediate", {
              amount: formatProviderAmount(position.parIntermediate.amount, locale),
            })}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/** A strategy's customer wallets, opened under its row, from positions the summary already read. */
function StrategyWalletDetails({
  cluster,
  strategy,
}: {
  cluster: SolanaCluster;
  strategy: EarnExternalWalletStrategyTotal;
}) {
  const t = useTranslations();
  // Absent when the summary could not hydrate this strategy's wallets.
  const positions = useMemo(
    () =>
      strategy.positions &&
      [...strategy.positions].sort((left, right) =>
        left.ownerAddress.localeCompare(right.ownerAddress)
      ),
    [strategy.positions]
  );

  // A band across the table, as a row's hover is. Padding, not margin: the reveal measures its
  // child's height, and a margin collapses out of it.
  return (
    <div className="pt-1 pb-2">
      <section aria-label={strategy.label} className="rounded-card bg-surface-tile py-1 text-meta">
        {positions ? (
          positions.map((position) => (
            <CustomerWallet cluster={cluster} key={position.id} position={position} />
          ))
        ) : (
          <Callout className="mx-3 my-2" variant="warning">
            {t("DashboardMarkets.earnProgram.walletRefreshError")}
          </Callout>
        )}
      </section>
    </div>
  );
}

function StrategyRows({
  cluster,
  definition,
  isOpen,
  onToggle,
  strategy,
}: {
  cluster: SolanaCluster;
  definition?: EarnStrategy;
  isOpen: boolean;
  onToggle: () => void;
  strategy: EarnExternalWalletStrategyTotal;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const detailsId = `embedded-yield-${earnStrategyReferenceKey(
    strategy.provider,
    strategy.providerReference
  ).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  // The row's mark is its first deposit token's; a strategy with no token totals shows none.
  const firstMint = strategy.totalsByToken[0]?.tokenMint;
  const asset = firstMint === undefined ? undefined : earnMintAsset(firstMint);
  const details = <StrategyWalletDetails cluster={cluster} strategy={strategy} />;
  const liquidity = definition ? earnStrategyLiquidityLabel(definition, t) : undefined;
  // Its provider and assets, then how fast money comes out.
  const detail = earnDetailLine([
    earnProviderLabel(strategy.provider),
    ...strategy.totalsByToken.map((total) => earnMintAsset(total.tokenMint).symbol),
    ...(liquidity ? [liquidity] : []),
  ]);

  return (
    <Fragment>
      <TableRow
        aria-controls={detailsId}
        aria-expanded={isOpen}
        aria-label={t("DashboardMarkets.earnProgram.viewCustomerWallets", {
          strategy: strategy.label,
        })}
        className="cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-strong"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        tabIndex={0}
      >
        <TableCell className={cn(PAYMENTS_TABLE_CELL, COLUMNS.strategy)}>
          <EarnRowIdentity asset={asset} detail={detail} name={strategy.label} />
        </TableCell>
        <TableCell className={cn(PAYMENTS_TABLE_CELL, COLUMNS.wallets, "tabular-nums")}>
          {strategy.walletCount}
        </TableCell>
        <TableCell className={cn(PAYMENTS_TABLE_CELL, COLUMNS.positions, "tabular-nums")}>
          {strategy.positionCount}
        </TableCell>
        <TableCell className={cn(PAYMENTS_TABLE_CELL, COLUMNS.lastDeposit, "text-secondary")}>
          <span className="block truncate">
            {formatLatestDepositDate(strategy.positions, locale)}
          </span>
        </TableCell>
        <TableCell className={cn(PAYMENTS_TABLE_CELL, COLUMNS.value, "tabular-nums")}>
          {strategy.totalsByToken.length === 0
            ? "—"
            : strategy.totalsByToken.map((total) => (
                <span className="block" key={total.tokenMint}>
                  {total.tokenValue === undefined ? (
                    <StatusText tone="attention">
                      {t("DashboardMarkets.earnProgram.valueUnavailable")}
                    </StatusText>
                  ) : (
                    formatTokenValue(total.tokenValue, total.tokenMint, locale)
                  )}
                </span>
              ))}
        </TableCell>
        <TableCell className={cn(PAYMENTS_TABLE_CELL, COLUMNS.toggle)}>
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "ml-auto size-4 text-tertiary transition-transform duration-200 ease-out motion-reduce:transition-none",
              isOpen && "rotate-90"
            )}
          />
        </TableCell>
      </TableRow>
      <tr id={detailsId}>
        <td className="p-0" colSpan={Object.keys(COLUMNS).length}>
          <AnimatePresence initial={false}>
            {isOpen ? (
              reduceMotion ? (
                <div key="wallets">{details}</div>
              ) : (
                <HeightReveal key="wallets">{details}</HeightReveal>
              )
            ) : null}
          </AnimatePresence>
        </td>
      </tr>
    </Fragment>
  );
}

function PortfolioByStrategy({
  cluster,
  notices,
  onStrategyToggle,
  selectedStrategyId,
  strategies,
  summary,
}: {
  cluster: SolanaCluster;
  notices: ReactNode;
  onStrategyToggle: (strategyId: string) => void;
  selectedStrategyId: string | null;
  strategies?: EarnStrategy[];
  summary: EarnExternalWalletPositionSummary;
}) {
  const t = useTranslations();
  const strategiesByReference = useMemo(
    () =>
      new Map(
        (strategies ?? []).map((strategy) => [
          earnStrategyReferenceKey(strategy.provider, strategy.providerReference),
          strategy,
        ])
      ),
    [strategies]
  );

  return (
    <RecordBlock
      hint={t("DashboardMarkets.earnProgram.portfolioDescription")}
      title={t("DashboardMarkets.earnProgram.portfolioTitle")}
    >
      {notices}
      <div className={EARN_TABLE_FRAME}>
        <Table className={EARN_TABLE} data-embedded-yield-table="strategies">
          <TableHeader>
            <TableRow>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, COLUMNS.strategy)}>
                {t("DashboardMarkets.earnProgram.strategy")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, COLUMNS.wallets)}>
                {t("DashboardMarkets.earnProgram.walletsColumn")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, COLUMNS.positions)}>
                {t("DashboardMarkets.earnProgram.positionsColumn")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, COLUMNS.lastDeposit)}>
                {t("DashboardMarkets.earnProgram.lastDeposit")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, COLUMNS.value)}>
                {t("DashboardMarkets.earnProgram.liveValue")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, COLUMNS.toggle)}>
                <span className="sr-only">{t("DashboardMarkets.earnProgram.customerWallets")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.totalsByStrategy.map((strategy) => {
              const strategyKey = earnStrategyReferenceKey(
                strategy.provider,
                strategy.providerReference
              );
              return (
                <StrategyRows
                  cluster={cluster}
                  definition={strategiesByReference.get(strategyKey)}
                  isOpen={selectedStrategyId === strategyKey}
                  key={strategyKey}
                  onToggle={() => onStrategyToggle(strategyKey)}
                  strategy={strategy}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>
    </RecordBlock>
  );
}

export function EmbeddedYieldDashboard({ configureHref }: { configureHref: string }) {
  const t = useTranslations();
  const href = useProjectHref();
  const cluster = useSolanaCluster();
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const { strategies } = useEarnStrategies();
  const { summary, error, isInitialLoading } = useEarnExternalWalletPositionSummary({
    detailsVisible: selectedStrategyId !== null,
  });

  if (isInitialLoading) return <EmbeddedYieldPortfolioSkeleton />;

  let content: ReactNode;
  if (!summary) {
    // No Integrate of its own: the header's stays on screen here, and only the zero-position
    // state moves that action into its body (`hidesPageAction`).
    content = (
      <ListEmptyState
        description={t("DashboardMarkets.earnProgram.portfolioErrorDescription")}
        message={t("DashboardMarkets.earnProgram.portfolioErrorTitle")}
      />
    );
  } else if (summary.positionCount === 0) {
    // Zero positions is the empty state alone: a zero hero and empty counts read as data, not as
    // "nothing yet". The removed UI builder persisted the only configuration there was, so no
    // "configured, awaiting a deposit" state can be told apart from the live summary.
    content = (
      <div className="flex min-w-0 flex-col gap-4">
        <PortfolioNotices refreshFailed={Boolean(error)} unavailablePositionCount={0} />
        <ListEmptyState
          action={
            <Button asChild>
              <Link href={href(configureHref)}>
                {t("DashboardMarkets.earnProgram.configureShort")}
              </Link>
            </Button>
          }
          description={t("DashboardMarkets.earnProgram.introDescription")}
          hidesPageAction
          message={t("DashboardMarkets.earnProgram.introTitle")}
        />
      </div>
    );
  } else {
    content = (
      <RecordStack>
        <PortfolioSummary summary={summary} />
        <PortfolioByStrategy
          cluster={cluster}
          notices={
            <PortfolioNotices
              refreshFailed={Boolean(error)}
              unavailablePositionCount={summary.unavailablePositionCount}
            />
          }
          onStrategyToggle={(strategyId) =>
            setSelectedStrategyId((current) => (current === strategyId ? null : strategyId))
          }
          selectedStrategyId={selectedStrategyId}
          strategies={strategies}
          summary={summary}
        />
      </RecordStack>
    );
  }

  return <DashboardWorkspaceOverviewPanel>{content}</DashboardWorkspaceOverviewPanel>;
}
