"use client";

import type {
  CustodyWalletTokenBalance,
  PaymentsDashboardWallet,
  PaymentTransferStatus,
  SolanaCluster,
} from "@sdp/types";
import { CoinsIcon, KeyIcon, ReceiptIcon, WalletIcon } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { DashboardQuickStart } from "@/components/dashboard-quick-start";
import { TokenMark } from "@/components/token-mark";
import { ActionTile } from "@/components/ui/action-tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusText } from "@/components/ui/status-text";
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
import { readApiErrorMessage } from "@/lib/api-error";
import {
  DASHBOARD_PAYMENTS_SUBNAV_HREFS,
  DASHBOARD_SIDE_NAV_HREFS,
} from "@/lib/dashboard-navigation-loading";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { formatRelativeTime } from "./activity-format-utils";
import { countHeldTokens } from "./home-balance-breakdown";
import { resolveHomeHeroState } from "./home-first-run";
import {
  filterHomeActivityRowsByFlags,
  type HomeActivityExplorerRef,
  type HomeActivityRow,
} from "./home-page.data";
import { buildTokenSymbolsByMint } from "./home-token-symbols";
import { fetchHomeActivity, fetchHomeVolume } from "./home-workspace.data";
import { OverviewNeedsYou } from "./overview-needs-you";
import { OverviewNetwork } from "./overview-network";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  formatTokenAmount,
  normalizeAggregateBalances,
  resolveTokenByMint,
  resolveTransferTokenLabel,
  resolveUsdBalanceValue,
  selectTopAggregateBalanceRows,
  shortenAddress,
  statusMessageKey,
} from "./payments/payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "./payments/payments-page.data";
import { PAYMENT_STATUS_TONE } from "./payments/payments-presentation";
import { tokenActivityHref } from "./tokens/holdings-links";

interface HomeWorkspaceProps {
  totalBalance: number | null;
  totalBalanceError: string | null;
  wallets: PaymentsDashboardWallet[];
  balances: CustodyWalletTokenBalance[];
  walletCount: number;
  issuedTokens: PaymentsIssuedTokenSymbol[];
}

const HOME_ACTIVITY_KEY = "dashboard-home-activity";
const HOME_ACTIVITY_CACHE_TTL_MS = 60_000;
const HOME_VOLUME_KEY = "dashboard-home-volume";
const BALANCE_ROW_COUNT = 3;

function explorerHref(ref: HomeActivityExplorerRef, cluster: SolanaCluster): string {
  return ref.kind === "tx"
    ? explorerTxUrl(ref.value, cluster)
    : explorerAddressUrl(ref.value, cluster);
}

/** The row's address shortened to 6…4, linked to Solana Explorer on the active cluster. */
function ActivityAddress({ row, cluster }: { row: HomeActivityRow; cluster: SolanaCluster }) {
  const t = useTranslations();
  if (row.address === "—" || row.address.trim() === "") {
    return <span className="text-tertiary">{t("Shared.homeWorkspace.noAddress")}</span>;
  }
  const label = shortenAddress(row.address);
  if (!row.explorer) {
    return (
      <span className="font-mono" title={row.address}>
        {label}
      </span>
    );
  }
  return (
    <a
      href={explorerHref(row.explorer, cluster)}
      target="_blank"
      rel="noreferrer"
      title={row.address}
      className="font-mono underline-offset-4 hover:underline"
    >
      {label}
    </a>
  );
}

/**
 * The zero state's left column: the balance it will fill, and the one thing everything else
 * waits on. A token needs somewhere to be held and a payment somewhere to leave from.
 */
function FirstWalletPrompt({ canCreateWallet }: { canCreateWallet: boolean }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <section className="min-w-0" data-overview-section="balance">
      <h2 className="text-body text-secondary">{t("Shared.homeWorkspace.totalBalance")}</h2>
      <p className="mt-1 text-amount font-medium text-primary tabular-nums">
        {formatCurrencyAmount(0, locale)}
      </p>
      <h3 className="mt-8 text-subheading font-medium text-primary">
        {t("Shared.homeWorkspace.firstRunTitle")}
      </h3>
      <p className="mt-2 max-w-sm text-body text-secondary">
        {t("Shared.homeWorkspace.firstRunBody")}
      </p>
      {canCreateWallet ? (
        <Button asChild variant="outline" className="mt-6 h-control-md">
          <Link href="/dashboard/wallets/setup">{t("Shared.homeWorkspace.createWallet")}</Link>
        </Button>
      ) : null}
    </section>
  );
}

/**
 * The populated left column, the same grammar as the Payments overview: the total at 40px, the
 * top holdings on 52px rows, and a one-line census of wallets, tokens and today's volume.
 */
function BalanceSummary({
  totalBalance,
  totalBalanceError,
  hasPricedValue,
  balances,
  walletCount,
  issuedTokensByMint,
  todaysVolume,
  todaysVolumeUnavailable,
}: {
  totalBalance: number | null;
  totalBalanceError: string | null;
  hasPricedValue: boolean;
  balances: CustodyWalletTokenBalance[];
  walletCount: number;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  todaysVolume: number | null;
  todaysVolumeUnavailable: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const issuedSymbolsByMint = Object.fromEntries(
    Object.entries(issuedTokensByMint).map(([mint, token]) => [mint, token.symbol])
  );
  const topBalances = selectTopAggregateBalanceRows(
    normalizeAggregateBalances(balances),
    issuedSymbolsByMint,
    BALANCE_ROW_COUNT
  );
  const heldTokenCount = countHeldTokens(balances);
  const census = [
    {
      key: "wallets",
      href: DASHBOARD_SIDE_NAV_HREFS.wallets,
      figure: walletCount.toLocaleString(locale),
      label: t(
        walletCount === 1
          ? "Shared.homeWorkspace.summary.wallets.one"
          : "Shared.homeWorkspace.summary.wallets.other"
      ),
    },
    {
      key: "tokens",
      href: "/dashboard/tokens",
      figure: heldTokenCount.toLocaleString(locale),
      label: t(
        heldTokenCount === 1
          ? "Shared.homeWorkspace.summary.tokens.one"
          : "Shared.homeWorkspace.summary.tokens.other"
      ),
    },
    {
      key: "volume",
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.transactions,
      // Still loading or failed reads as a dash, never as a measured $0.00.
      figure: todaysVolumeUnavailable ? "—" : formatCurrencyAmount(todaysVolume, locale),
      label: t("Shared.homeWorkspace.summary.volume"),
    },
  ];

  return (
    <section className="min-w-0" data-overview-section="balance">
      <h2 className="text-body text-secondary">{t("Shared.homeWorkspace.totalBalance")}</h2>
      {totalBalanceError ? (
        <>
          <p className="mt-1 text-amount font-medium text-primary">
            {t("Shared.homeWorkspace.unavailable")}
          </p>
          <p className="mt-2 text-body text-error">{totalBalanceError}</p>
        </>
      ) : hasPricedValue ? (
        <p className="mt-1 text-amount font-medium text-primary tabular-nums">
          {formatCurrencyAmount(totalBalance, locale)}
        </p>
      ) : (
        // Holding only unpriced tokens (an organization's own issuance) has no dollar total;
        // $0.00 beside real holdings would read as a broken figure rather than an absent one.
        <>
          <p className="mt-1 text-subheading font-medium text-primary">
            {t("Shared.homeWorkspace.heroUnpricedTitle")}
          </p>
          <p className="mt-1 text-body text-tertiary">
            {t("Shared.homeWorkspace.heroUnpricedBody")}
          </p>
        </>
      )}
      {topBalances.length > 0 ? (
        // 52px rows: a 36px mark beside a 16px name over its 14px amount, 8px apart.
        <ul className="mt-8 space-y-2">
          {topBalances.map((balance) => {
            const resolved = resolveTokenByMint(balance.mint, issuedTokensByMint, balance.token);
            const label =
              resolved.tokenName.length > 12
                ? shortenAddress(resolved.tokenName)
                : resolved.tokenName;
            const usdValue = resolveUsdBalanceValue(balance);
            return (
              <li key={`${balance.token}-${balance.mint}`}>
                <Link
                  href={tokenActivityHref(balance.mint)}
                  className="-mx-2 flex min-w-0 items-center gap-4 rounded-control px-2 py-1 transition-colors hover:bg-fill-subtle focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                  <TokenMark
                    mint={resolved.mint}
                    symbol={resolved.tokenName}
                    logoUrl={resolved.metadataImageUrl}
                    size="lg"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-field text-primary" title={resolved.tokenName}>
                        {label}
                      </span>
                      {resolved.tokenId ? (
                        <Badge variant="outline" className="shrink-0">
                          {t("Shared.SharedComponents.sdpMintedToken")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block text-body text-secondary tabular-nums">
                      {formatTokenAmount(balance.uiAmount, locale)}
                    </span>
                  </span>
                  {usdValue === null ? null : (
                    <span className="shrink-0 text-field text-primary tabular-nums">
                      {formatCurrencyAmount(usdValue, locale)}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="mt-9 border-t border-border-default pt-6">
        {/* The counts read at 18px over their 14px words, on one baseline. */}
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body text-secondary">
          {census.map((item, index) => (
            <Fragment key={item.key}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-tertiary">
                  ·
                </span>
              ) : null}
              <Link href={item.href} className="transition-colors hover:text-primary">
                <span className="text-subheading font-medium text-primary tabular-nums">
                  {item.figure}
                </span>{" "}
                {item.label}
              </Link>
            </Fragment>
          ))}
        </p>
      </div>
    </section>
  );
}

interface OverviewTile {
  key: string;
  href: string;
  icon: typeof WalletIcon;
  label: MessageKey;
  description: MessageKey;
}

/** Up to four tinted tiles that start the organization's main flows, two to a row. */
function OverviewActions({ tiles }: { tiles: readonly OverviewTile[] }) {
  const t = useTranslations();
  if (tiles.length === 0) return null;
  return (
    <section
      className="grid min-w-0 grid-cols-2 content-start gap-2"
      aria-label={t("Shared.homeWorkspace.actionsLabel")}
      data-overview-section="actions"
    >
      {tiles.map((tile) => (
        <ActionTile
          key={tile.key}
          href={tile.href}
          icon={tile.icon}
          label={t(tile.label)}
          description={t(tile.description)}
        />
      ))}
    </section>
  );
}

function activityStatusLabel(
  row: HomeActivityRow,
  t: ReturnType<typeof useTranslations>,
  locale: string
): string {
  const status = t(statusMessageKey(row.status as PaymentTransferStatus));
  // An issuance row names what it did ("Deploy failed"); a payment's status says enough alone.
  return row.sourceKind === "issuance"
    ? t("Shared.homeWorkspace.issuanceStatus", {
        type: row.type,
        status: status.toLocaleLowerCase(locale),
      })
    : status;
}

function activityAmountLabel(
  row: HomeActivityRow,
  t: ReturnType<typeof useTranslations>,
  locale: string
): { text: string; missing: boolean } {
  if (row.amount === "—") {
    return {
      text: t(
        row.sourceKind === "issuance"
          ? "Shared.homeWorkspace.notMinted"
          : "Shared.homeWorkspace.notSent"
      ),
      missing: true,
    };
  }
  return { text: formatDisplayAmount(row.amount, "", locale).trim(), missing: false };
}

function RecentActivity({
  rows,
  error,
  notice,
  emptyMessage,
  symbolsByMint,
  issuedTokensByMint,
  showSeeAll,
}: {
  rows: HomeActivityRow[];
  error: string | null;
  notice: string | null;
  emptyMessage: string;
  symbolsByMint: Record<string, string>;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  showSeeAll: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = useSolanaCluster();
  return (
    <section
      aria-labelledby="overview-activity-title"
      data-overview-section="activity"
      className="min-w-0"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="overview-activity-title" className="text-subheading font-medium text-primary">
          {t("Shared.homeWorkspace.recentActivity")}
        </h2>
        {showSeeAll ? (
          <Button asChild variant="outline" size="sm">
            <Link href={DASHBOARD_PAYMENTS_SUBNAV_HREFS.transactions}>
              {t("Shared.homeWorkspace.seeAllPayments")}
            </Link>
          </Button>
        ) : null}
      </div>
      {notice && !error ? <p className="mt-2 text-body text-tertiary">{notice}</p> : null}
      {error ? (
        <p className="mt-4 text-body text-error">{error}</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-body text-tertiary">{emptyMessage}</p>
      ) : (
        <TooltipProvider>
          <Table className="mt-3 min-w-0 rounded-none border-0 refresh:-mx-3 [&_table]:table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[15%]">{t("Shared.homeWorkspace.time")}</TableHead>
                <TableHead className="w-[85%] md:hidden">
                  {t("Shared.homeWorkspace.activity")}
                </TableHead>
                <TableHead className="hidden w-[27%] md:table-cell">
                  {t("Shared.homeWorkspace.type")}
                </TableHead>
                <TableHead className="hidden w-[18%] md:table-cell">
                  {t("Shared.homeWorkspace.token")}
                </TableHead>
                <TableHead className="hidden w-[17%] text-right md:table-cell">
                  {t("Shared.homeWorkspace.amount")}
                </TableHead>
                <TableHead className="hidden pl-6 md:table-cell">
                  {t("Shared.homeWorkspace.address")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const createdAt = new Date(row.createdAt);
                const timeTooltip = Number.isNaN(createdAt.getTime())
                  ? null
                  : new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(createdAt);
                const timeLabel = formatRelativeTime(row.createdAt, locale);
                // `row.token` is resolved against issued tokens only; the balances carry the
                // symbols for everything else.
                const tokenSymbol =
                  resolveTransferTokenLabel(row.tokenMint, symbolsByMint) ?? row.token;
                const resolvedToken = row.tokenMint
                  ? resolveTokenByMint(row.tokenMint, issuedTokensByMint, tokenSymbol)
                  : null;
                const status = activityStatusLabel(row, t, locale);
                const tone = PAYMENT_STATUS_TONE[row.status];
                const amount = activityAmountLabel(row, t, locale);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-primary">
                      {timeTooltip ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>{timeLabel}</span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            {timeTooltip}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        timeLabel
                      )}
                    </TableCell>
                    <TableCell className="min-w-0 md:hidden">
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <StatusText tone={tone} className="truncate">
                          {status}
                        </StatusText>
                        <span className="shrink-0 text-primary tabular-nums">
                          {amount.missing ? amount.text : `${amount.text} ${tokenSymbol}`}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <StatusText tone={tone} className="block truncate">
                        {status}
                      </StatusText>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <span className="flex min-w-0 items-center gap-2 text-primary">
                        <TokenMark
                          mint={resolvedToken ? resolvedToken.mint : null}
                          symbol={tokenSymbol}
                          logoUrl={resolvedToken?.metadataImageUrl}
                          size="xs"
                        />
                        <span className="truncate" title={tokenSymbol}>
                          {tokenSymbol}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-right md:table-cell">
                      <span
                        className={
                          amount.missing
                            ? "block truncate text-tertiary"
                            : "block truncate text-primary tabular-nums"
                        }
                      >
                        {amount.text}
                      </span>
                    </TableCell>
                    <TableCell className="hidden truncate pl-6 text-primary md:table-cell">
                      <ActivityAddress row={row} cluster={cluster} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TooltipProvider>
      )}
    </section>
  );
}

/**
 * Today's volume, read apart from the activity list: it waits on every wallet so the total is
 * never a sum over some of them, and the list does not wait on it.
 */
function useHomeVolume() {
  const { data: volumeSnapshot, error: volumeRequestError } = usePersistedDashboardSWR(
    HOME_VOLUME_KEY,
    () => fetchHomeVolume(),
    {
      revalidateOnFocus: true,
      refreshInterval: 20_000,
    },
    {
      key: "home-volume",
      ttlMs: HOME_ACTIVITY_CACHE_TTL_MS,
    }
  );
  return {
    todaysVolume: volumeSnapshot?.todaysVolume ?? null,
    todaysVolumeUnavailable:
      Boolean(volumeRequestError) ||
      volumeSnapshot === undefined ||
      Boolean(volumeSnapshot.todaysVolumeError),
  };
}

function useHomeActivity(
  balances: CustodyWalletTokenBalance[],
  issuanceEnabled: boolean,
  isWalletEmptyState: boolean
) {
  const t = useTranslations();
  const { data: activitySnapshot, error: activityRequestError } = usePersistedDashboardSWR(
    HOME_ACTIVITY_KEY,
    () => fetchHomeActivity(),
    {
      revalidateOnFocus: true,
      refreshInterval: 20_000,
    },
    {
      key: "home-activity",
      ttlMs: HOME_ACTIVITY_CACHE_TTL_MS,
    }
  );
  const activityRows = filterHomeActivityRowsByFlags(activitySnapshot?.activityRows ?? [], {
    issuance: issuanceEnabled,
  });
  const symbolsByMint = buildTokenSymbolsByMint(activityRows, balances);
  const activityError = activityRequestError
    ? readApiErrorMessage(activityRequestError) || t("Shared.homeWorkspace.activityUnavailable")
    : (activitySnapshot?.activityError ?? null);
  const activityNotice = activitySnapshot?.activityNotice ?? null;
  const emptyActivityMessage = isWalletEmptyState
    ? t("Shared.homeWorkspace.createFirstWalletActivity")
    : activitySnapshot
      ? t("Shared.homeWorkspace.noRecentActivity")
      : t("Shared.homeWorkspace.loadingRecentActivity");

  return {
    activityRows,
    symbolsByMint,
    activityError,
    activityNotice,
    emptyActivityMessage,
  };
}

/**
 * The Overview: setup while it is unfinished, the organization's balance beside the flows it can
 * start, approvals waiting on the viewer, Solana network context, and the latest activity.
 * Before the first wallet the balance column becomes the prompt to create one and the activity
 * list stays out, since there is nothing it could show.
 */
export function HomeWorkspace({
  totalBalance,
  totalBalanceError,
  wallets,
  balances,
  walletCount,
  issuedTokens,
}: HomeWorkspaceProps) {
  const { dashboardAccess, flags } = useDashboardWorkspace();
  const { capabilities } = dashboardAccess;
  const heroState = resolveHomeHeroState({
    walletCount,
    balances,
    totalBalance,
    balancesUnavailable: totalBalanceError !== null,
  });
  const firstRun = heroState.kind === "first_run";
  const issuedTokensByMint = Object.fromEntries(
    issuedTokens.map((token) => [token.mintAddress, token])
  );
  const { todaysVolume, todaysVolumeUnavailable } = useHomeVolume();
  const { activityRows, symbolsByMint, activityError, activityNotice, emptyActivityMessage } =
    useHomeActivity(balances, flags.issuance, wallets.length === 0);

  const canCreateWallet = flags.custody && capabilities.canManageCustody;
  const tiles: OverviewTile[] = [
    ...(canCreateWallet && !firstRun
      ? [
          {
            key: "wallet",
            href: "/dashboard/wallets/setup",
            icon: WalletIcon,
            label: "Shared.homeWorkspace.quickActionWallets",
            description: "Shared.homeWorkspace.quickActionWalletsBody",
          } as const,
        ]
      : []),
    ...(flags.issuance && capabilities.canManageTokenWrite
      ? [
          {
            key: "token",
            href: "/dashboard/issuance/create",
            icon: CoinsIcon,
            label: "Shared.homeWorkspace.quickActionToken",
            description: "Shared.homeWorkspace.quickActionTokenBody",
          } as const,
        ]
      : []),
    ...(flags.payments && !firstRun
      ? [
          {
            key: "payment",
            href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.pay,
            icon: ReceiptIcon,
            label: "Shared.homeWorkspace.quickActionPayments",
            description: "Shared.homeWorkspace.quickActionPaymentsBody",
          } as const,
        ]
      : []),
    ...(capabilities.canManageApiKeys
      ? [
          {
            key: "api-key",
            href: "/dashboard/api-keys/new",
            icon: KeyIcon,
            label: "Shared.homeWorkspace.quickActionApiKeys",
            description: "Shared.homeWorkspace.quickActionApiKeysBody",
          } as const,
        ]
      : []),
  ];

  return (
    // 64px under the last section, as the refresh panels leave: the shell pads nothing at the
    // foot of a refresh page, so Recent activity would otherwise end on the window's edge.
    <div className="flex w-full min-w-0 flex-col gap-16 pb-16" data-overview>
      <DashboardQuickStart variant="overview" />
      <div className="grid min-w-0 gap-10 lg:grid-cols-2 lg:gap-12">
        {firstRun ? (
          <FirstWalletPrompt canCreateWallet={canCreateWallet} />
        ) : (
          <BalanceSummary
            totalBalance={totalBalance}
            totalBalanceError={totalBalanceError}
            hasPricedValue={heroState.kind === "populated" ? heroState.hasPricedValue : true}
            balances={balances}
            walletCount={walletCount}
            issuedTokensByMint={issuedTokensByMint}
            todaysVolume={todaysVolume}
            todaysVolumeUnavailable={todaysVolumeUnavailable}
          />
        )}
        <OverviewActions tiles={tiles} />
      </div>
      {flags.policies && capabilities.canReadApprovals ? <OverviewNeedsYou /> : null}
      <OverviewNetwork />
      {firstRun ? null : (
        <RecentActivity
          rows={activityRows}
          error={activityError}
          notice={activityNotice}
          emptyMessage={emptyActivityMessage}
          symbolsByMint={symbolsByMint}
          issuedTokensByMint={issuedTokensByMint}
          showSeeAll={flags.payments}
        />
      )}
    </div>
  );
}
