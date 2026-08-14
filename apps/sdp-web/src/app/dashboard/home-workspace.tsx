"use client";

import type { CustodyWalletTokenBalance, PaymentsDashboardWallet, SolanaCluster } from "@sdp/types";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CreateApiKeyModal } from "@/app/dashboard/api-keys/create-api-key-modal";
import { SectionEntry } from "@/app/dashboard/wallets/section-entry";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "./activity-format-utils";
import { buildHomeBalanceBreakdown, countHeldTokens } from "./home-balance-breakdown";
import { resolveHomeHeroState } from "./home-first-run";
import type { HomeActivityExplorerRef, HomeActivityRow } from "./home-page.data";
import { HomeQuickActions } from "./home-quick-actions";
import { seriesColorForMint } from "./home-series-color";
import { buildTokenSymbolsByMint } from "./home-token-symbols";
import { fetchHomeActivity } from "./home-workspace.data";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  resolveTokenByMint,
  resolveTransferTokenLabel,
} from "./payments/payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "./payments/payments-page.data";
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

/** Table text that ellipsizes, with a full-value tooltip only while it actually overflows. */
function TruncatedTableText({ value, className }: { value: string; className?: string }) {
  const textRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: flipping isOverflowing swaps the div between plain and tooltip-trigger positions (a remount), so the observer must re-attach to the new node; a value change alters scrollWidth without any resize event.
  useEffect(() => {
    const node = textRef.current;
    if (!node) return;

    const measure = () => setIsOverflowing(node.scrollWidth > node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [value, isOverflowing]);

  const text = (
    <div ref={textRef} className={className ?? "truncate"}>
      {value}
    </div>
  );

  if (!isOverflowing) {
    return text;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{text}</TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[32rem] break-all text-xs">
        {value}
      </TooltipContent>
    </Tooltip>
  );
}

function explorerHref(ref: HomeActivityExplorerRef, cluster: SolanaCluster): string {
  return ref.kind === "tx"
    ? explorerTxUrl(ref.value, cluster)
    : explorerAddressUrl(ref.value, cluster);
}

/** Renders the activity address, linked to Solana Explorer on the active cluster when linkable. */
function ActivityAddress({
  row,
  cluster,
  className,
}: {
  row: HomeActivityRow;
  cluster: SolanaCluster;
  className?: string;
}) {
  if (!row.explorer) {
    return <TruncatedTableText value={row.address} className={className} />;
  }
  return (
    <a
      href={explorerHref(row.explorer, cluster)}
      target="_blank"
      rel="noreferrer"
      className="flex min-w-0 max-w-full items-center gap-1 text-primary underline underline-offset-2"
    >
      <TruncatedTableText value={row.address} className={`min-w-0 ${className ?? "truncate"}`} />
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

/**
 * "Other" is a residual bucket, not a token, so it stays neutral rather than
 * taking a categorical hue that would imply an identity it does not have.
 */
const OTHER_SEGMENT_COLOR = "bg-fill-strong";

/**
 * Holdings by token. The aggregate already returns the per-token rows the total is
 * summed from, so this needs no extra request.
 *
 * Priced holdings compose one stacked allocation bar; unpriced ones are listed below
 * it without a bar. An organization's own issued tokens have no price feed, and the
 * first version drew a share bar for every row — the unpriced ones rendered as empty
 * full-width rules that read as dividers, and comparing a raw token count against a
 * dollar amount was meaningless anyway.
 */
function BalanceAllocation({
  balances,
  issuedTokensByMint,
  locale,
}: {
  balances: CustodyWalletTokenBalance[];
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  locale: string;
}) {
  const t = useTranslations();
  const [hovered, setHovered] = useState<string | null>(null);
  const breakdown = buildHomeBalanceBreakdown(balances);
  if (breakdown.priced.length === 0 && breakdown.unpriced.length === 0) {
    return null;
  }

  // Balances carry their own symbols, so tokens the catalogue has never heard of
  // still get named rather than falling back to a shortened mint.
  const symbolsByMint = Object.fromEntries(
    balances.map((balance) => [balance.mint, balance.token])
  );
  const symbolFor = (slice: { mint: string; token: string }) =>
    resolveTransferTokenLabel(slice.mint, symbolsByMint) ?? slice.token;
  const resolvedFor = (mint: string, symbol: string) =>
    resolveTokenByMint(mint, issuedTokensByMint, symbol);

  const segments = [
    ...breakdown.priced.map((slice) => ({
      key: slice.mint,
      mint: slice.mint,
      label: symbolFor(slice),
      percent: slice.sharePercent,
      value: slice.usdValue ?? 0,
      fill: seriesColorForMint(slice.mint),
      href: tokenActivityHref(slice.mint),
    })),
    ...(breakdown.otherPricedCount > 0
      ? [
          {
            key: "__other__",
            mint: null,
            label:
              breakdown.otherPricedCount === 1
                ? t("Shared.homeWorkspace.singleOtherToken")
                : t("Shared.homeWorkspace.otherTokensCount", {
                    count: breakdown.otherPricedCount,
                  }),
            percent: breakdown.otherPricedSharePercent,
            value: breakdown.otherPricedUsd,
            fill: OTHER_SEGMENT_COLOR,
            href: "/dashboard/tokens",
          },
        ]
      : []),
  ];

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[15px] text-tertiary">{t("Shared.homeWorkspace.balanceByToken")}</p>
        {breakdown.totalUsd !== null ? (
          <p className="text-[15px] font-medium text-primary tabular-nums">
            {formatCurrencyAmount(breakdown.totalUsd, locale)}
          </p>
        ) : null}
      </div>

      {segments.length > 0 ? (
        <>
          {/* Hovering either the bar or its row lifts the same segment, so the two
              read as one object. gap-0.5 is the 2px spacer that stops adjacent
              fills merging into a single block. */}
          <div className="flex h-2.5 w-full gap-0.5 overflow-hidden">
            {segments.map((segment) => (
              <Link
                key={segment.key}
                href={segment.href}
                aria-label={`${segment.label} ${Math.round(segment.percent)}%`}
                onMouseEnter={() => setHovered(segment.key)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(segment.key)}
                onBlur={() => setHovered(null)}
                style={{ width: `${Math.max(segment.percent, 1.5)}%` }}
                className={cn(
                  "h-full rounded-full transition-opacity motion-reduce:transition-none",
                  segment.fill,
                  hovered && hovered !== segment.key ? "opacity-35" : "opacity-100"
                )}
              />
            ))}
          </div>

          <ul className="space-y-1">
            {segments.map((segment) => {
              const resolved = segment.mint ? resolvedFor(segment.mint, segment.label) : null;
              return (
                <li key={segment.key}>
                  {/* Row highlight is pure CSS. Driving it from mouse handlers on a
                    plain element is a keyboard trap — the segment button above owns
                    the interaction, and this only mirrors it. */}
                  <Link
                    href={segment.href}
                    onMouseEnter={() => setHovered(segment.key)}
                    onMouseLeave={() => setHovered(null)}
                    className={cn(
                      "flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-fill-subtle motion-reduce:transition-none",
                      hovered === segment.key ? "bg-fill-subtle" : "bg-transparent"
                    )}
                  >
                    {segment.mint ? (
                      <TokenMark
                        mint={segment.mint}
                        symbol={segment.label}
                        logoUrl={resolved?.metadataImageUrl}
                        size="sm"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className={cn("size-6 shrink-0 rounded-full", segment.fill)}
                      />
                    )}
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate text-[15px] font-medium text-primary">
                        {segment.label}
                      </span>
                      {resolved?.tokenId ? (
                        <Badge variant="outline" className="shrink-0">
                          {t("Shared.SharedComponents.sdpMintedToken")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1" />
                    <span className="shrink-0 text-[15px] text-tertiary tabular-nums">
                      {Math.round(segment.percent)}%
                    </span>
                    <span className="w-28 shrink-0 text-right text-[15px] font-medium text-primary tabular-nums">
                      {formatCurrencyAmount(segment.value, locale)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {breakdown.unpriced.length > 0 ? (
        <div className="space-y-1 border-t border-border-default pt-4">
          <p className="px-2 pb-1 text-xs text-tertiary">{t("Shared.homeWorkspace.notPriced")}</p>
          {breakdown.unpriced.map((slice) => {
            const symbol = symbolFor(slice);
            const resolved = resolvedFor(slice.mint, symbol);
            return (
              <Link
                key={slice.mint}
                href={tokenActivityHref(slice.mint)}
                className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-fill-subtle motion-reduce:transition-none"
              >
                <TokenMark
                  mint={slice.mint}
                  symbol={symbol}
                  logoUrl={resolved.metadataImageUrl}
                  size="sm"
                />
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 truncate text-[15px] font-medium text-primary">
                    {symbol}
                  </span>
                  {resolved.tokenId ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("Shared.SharedComponents.sdpMintedToken")}
                    </Badge>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1" />
                <span className="shrink-0 text-[15px] text-secondary tabular-nums">
                  {formatDisplayAmount(slice.uiAmount, symbol)}
                </span>
              </Link>
            );
          })}
          {breakdown.otherUnpricedCount > 0 ? (
            /* Was a dead count with no affordance — the holdings page is what it
               was implicitly promising all along. */
            <Link
              href="/dashboard/tokens"
              className="inline-block px-2 pt-1 text-[13px] text-primary underline underline-offset-2"
            >
              {breakdown.otherUnpricedCount === 1
                ? t("Shared.homeWorkspace.singleMoreToken")
                : t("Shared.homeWorkspace.moreTokensCount", {
                    count: breakdown.otherUnpricedCount,
                  })}
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* A summary capped at four priced and four unpriced holdings needs somewhere
          to send anyone holding more than it shows. Sits after the rows rather than
          between the header and the bar, where it split the two apart and read as a
          gap in the card. */}
      <Link
        href="/dashboard/tokens"
        className="inline-block text-[13px] text-primary underline underline-offset-2"
      >
        {t("Shared.homeWorkspace.viewAllHoldings")}
      </Link>
    </div>
  );
}

/** A secondary figure beside the hero — deliberately far smaller than the balance. */
function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[13px] text-tertiary">{label}</dt>
      <dd className="truncate text-[22px] leading-tight font-medium tracking-[-0.02em] text-primary tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/**
 * One number, at the top, at maximum weight.
 *
 * Four equal tiles gave the balance, the day's volume, a wallet count and a token
 * count identical visual weight, so the page answered no question first — the reader
 * had to pick. Total balance is what someone opening a custody dashboard came for,
 * so it leads; everything else is context beside it, and the primary action sits in
 * the same block rather than floating above the page.
 */
function BalanceHero({
  totalBalance,
  totalBalanceError,
  totalBalanceHint,
  hasPricedValue,
  todaysVolume,
  todaysVolumeError,
  walletCount,
  heldTokenCount,
  balances,
  issuedTokensByMint,
  locale,
  canManageApiKeys,
  canManageCustody,
}: {
  totalBalance: number | null;
  totalBalanceError: string | null;
  totalBalanceHint: string | null;
  hasPricedValue: boolean;
  todaysVolume: number | null;
  todaysVolumeError: string | null;
  walletCount: number;
  heldTokenCount: number;
  balances: CustodyWalletTokenBalance[];
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  locale: string;
  canManageApiKeys: boolean;
  canManageCustody: boolean;
}) {
  const t = useTranslations();
  return (
    <Card className="min-w-0 gap-0 rounded-[18px] py-0 shadow-none">
      <CardContent className="space-y-6 px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 space-y-2">
            <p className="text-[15px] text-tertiary">{t("Shared.homeWorkspace.totalBalance")}</p>
            {/* An organization holding only its own issued tokens has no price feed
                for anything it owns. Formatting that as currency printed $0.00 next
                to real holdings, which reads as a broken number rather than an
                absent one. */}
            {totalBalanceError ? (
              <p className="text-[38px] leading-none font-medium tracking-[-0.03em] text-primary tabular-nums sm:text-[46px]">
                {t("Shared.homeWorkspace.unavailable")}
              </p>
            ) : hasPricedValue ? (
              <p className="text-[38px] leading-none font-medium tracking-[-0.03em] text-primary tabular-nums sm:text-[46px]">
                {formatCurrencyAmount(totalBalance, locale)}
              </p>
            ) : (
              <>
                <p className="text-[22px] leading-tight font-medium tracking-[-0.02em] text-primary">
                  {t("Shared.homeWorkspace.heroUnpricedTitle")}
                </p>
                <p className="text-sm text-tertiary">
                  {t("Shared.homeWorkspace.heroUnpricedBody")}
                </p>
              </>
            )}
            {totalBalanceError ? (
              <p className="text-sm text-destructive-strong">{totalBalanceError}</p>
            ) : totalBalanceHint && hasPricedValue ? (
              <p className="text-sm text-tertiary">{totalBalanceHint}</p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {canManageApiKeys ? (
              <CreateApiKeyModal
                triggerLabel={t("Shared.SharedComponents.createApiKey")}
                triggerVariant="secondary"
              />
            ) : null}
            {canManageCustody ? (
              // Secondary, not primary. An organization with balances has already
              // created its wallets; leading this screen with "Create Wallet" gave
              // a setup action top billing over the numbers the page exists to
              // show. It stays reachable, it just stops competing with them.
              <Button asChild variant="secondary">
                <Link href="/dashboard/wallets">{t("Shared.homeWorkspace.createWallet")}</Link>
              </Button>
            ) : null}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border-default pt-5 sm:grid-cols-3">
          <HeroStat
            label={t("Shared.homeWorkspace.todaysVolume")}
            value={
              todaysVolumeError
                ? t("Shared.homeWorkspace.unavailable")
                : formatCurrencyAmount(todaysVolume, locale)
            }
          />
          <HeroStat
            label={t("Shared.homeWorkspace.walletsTracked")}
            value={walletCount.toLocaleString(locale)}
          />
          <HeroStat
            label={t("Shared.homeWorkspace.tokensHeld")}
            value={heldTokenCount.toLocaleString(locale)}
          />
        </dl>

        {balances.length > 0 ? (
          <div className="border-t border-border-default pt-5">
            <BalanceAllocation
              balances={balances}
              issuedTokensByMint={issuedTokensByMint}
              locale={locale}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * What to do when there is nothing yet.
 *
 * The populated layout rendered four zeroes and a hint under each, which reads as a
 * broken dashboard rather than a new one. A first run gets one instruction and the
 * action next to it instead.
 */
function FirstRunPanel({ canCreateWallet }: { canCreateWallet: boolean }) {
  const t = useTranslations();
  return (
    <Card className="min-w-0 gap-0 rounded-[18px] py-0 shadow-none">
      <CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 px-6 py-8">
        <div className="min-w-0 max-w-xl space-y-2">
          <h2 className="text-[22px] leading-tight font-medium tracking-[-0.02em] text-primary">
            {t("Shared.homeWorkspace.firstRunTitle")}
          </h2>
          <p className="text-sm text-tertiary">{t("Shared.homeWorkspace.firstRunBody")}</p>
        </div>
        {canCreateWallet ? (
          <Button
            asChild
            className="!text-on-primary hover:!text-on-primary visited:!text-on-primary"
          >
            <Link href="/dashboard/wallets">{t("Shared.homeWorkspace.createWallet")}</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function HomeWorkspace({
  totalBalance,
  totalBalanceError,
  wallets,
  balances,
  walletCount,
  issuedTokens,
}: HomeWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = useSolanaCluster();
  const { dashboardAccess } = useDashboardWorkspace();
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
  const isWalletEmptyState = wallets.length === 0;
  const heldTokenCount = countHeldTokens(balances);
  // Not `wallets.length === 0`: onboarding provisions a wallet before it completes,
  // so a freshly onboarded organization already has one and fell through to the
  // populated hero holding nothing.
  // `totalBalanceError` is set only when the aggregate request itself failed
  // on an organization that has wallets. That is the only failure the response
  // exposes today: the API converts per-wallet read failures into zero rows on
  // a 200, so an RPC blip that zeroes an established organization is not
  // distinguishable here from genuine emptiness. Closing that requires the
  // aggregate to report partial reads (HOO-1040).
  const heroState = resolveHomeHeroState({
    walletCount,
    balances,
    totalBalance,
    balancesUnavailable: totalBalanceError !== null,
  });
  const totalBalanceHint = isWalletEmptyState
    ? t("Shared.homeWorkspace.createFirstWalletBalances")
    : totalBalance === null
      ? t("Shared.homeWorkspace.noTrackedBalances")
      : null;
  const todaysVolume = activitySnapshot?.todaysVolume ?? null;
  const todaysVolumeError = activityRequestError
    ? activityRequestError instanceof Error
      ? activityRequestError.message || t("Shared.homeWorkspace.activityUnavailable")
      : t("Shared.homeWorkspace.activityUnavailable")
    : (activitySnapshot?.activityError ?? null);
  const activityRows = activitySnapshot?.activityRows ?? [];
  const symbolsByMint = buildTokenSymbolsByMint(activityRows, balances);
  const issuedTokensByMint = Object.fromEntries(
    issuedTokens.map((token) => [token.mintAddress, token])
  );
  const activityError = activityRequestError
    ? activityRequestError instanceof Error
      ? activityRequestError.message || t("Shared.homeWorkspace.activityUnavailable")
      : t("Shared.homeWorkspace.activityUnavailable")
    : (activitySnapshot?.activityError ?? null);
  const activityNotice = activitySnapshot?.activityNotice ?? null;
  const emptyActivityMessage = isWalletEmptyState
    ? t("Shared.homeWorkspace.createFirstWalletActivity")
    : activitySnapshot
      ? t("Shared.homeWorkspace.noRecentActivity")
      : t("Shared.homeWorkspace.loadingRecentActivity");

  return (
    <div className="w-full space-y-8 py-2">
      <SectionEntry>
        {heroState.kind === "first_run" ? (
          <FirstRunPanel canCreateWallet={dashboardAccess.capabilities.canManageCustody} />
        ) : heroState.kind === "provisioned_empty" ? (
          <HomeQuickActions capabilities={dashboardAccess.capabilities} />
        ) : (
          <BalanceHero
            totalBalance={totalBalance}
            totalBalanceError={totalBalanceError}
            totalBalanceHint={totalBalanceHint}
            hasPricedValue={heroState.hasPricedValue}
            todaysVolume={todaysVolume}
            todaysVolumeError={todaysVolumeError}
            walletCount={walletCount}
            heldTokenCount={heldTokenCount}
            balances={balances}
            issuedTokensByMint={issuedTokensByMint}
            locale={locale}
            canManageApiKeys={dashboardAccess.capabilities.canManageApiKeys}
            canManageCustody={dashboardAccess.capabilities.canManageCustody}
          />
        )}
      </SectionEntry>

      <SectionEntry delay={0.08}>
        <div className="space-y-4">
          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <CardTitle>{t("Shared.homeWorkspace.recentTransactions")}</CardTitle>
                {activityNotice ? (
                  <CardDescription>{activityNotice}</CardDescription>
                ) : (
                  <CardDescription>{t("Shared.homeWorkspace.activityDescription")}</CardDescription>
                )}
              </div>
              <Button asChild variant="secondary" size="sm">
                <Link href="/dashboard/payments">{t("Shared.homeWorkspace.seeAllPayments")}</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {activityError ? (
                <p className="text-sm text-destructive-strong">{activityError}</p>
              ) : activityRows.length === 0 ? (
                <p className="text-sm text-secondary">{emptyActivityMessage}</p>
              ) : (
                <TooltipProvider>
                  <Table className="min-w-0 [&_table]:table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[8rem] pl-6">
                          {t("Shared.homeWorkspace.time")}
                        </TableHead>
                        <TableHead className="w-[calc(100%-8rem)] md:hidden">
                          {t("Shared.homeWorkspace.activity")}
                        </TableHead>
                        <TableHead className="hidden w-[9.5rem] md:table-cell">
                          {t("Shared.homeWorkspace.type")}
                        </TableHead>
                        <TableHead className="hidden w-[15rem] md:table-cell">
                          {t("Shared.homeWorkspace.token")}
                        </TableHead>
                        <TableHead className="hidden w-[9rem] text-right md:table-cell">
                          {t("Shared.homeWorkspace.amount")}
                        </TableHead>
                        <TableHead className="hidden pr-6 md:table-cell">
                          {t("Shared.homeWorkspace.address")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {activityRows.map((row) => {
                        const timeLabel = formatRelativeTime(row.createdAt, locale);
                        const createdAtDate = new Date(row.createdAt);
                        const timeTooltip = Number.isNaN(createdAtDate.getTime())
                          ? null
                          : new Intl.DateTimeFormat(locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(createdAtDate);
                        // `row.token` is already resolved, but only against issued
                        // tokens — anything else arrives as a shortened mint. Re-resolve
                        // from the mint using the balance symbols before falling back.
                        const tokenSymbol =
                          resolveTransferTokenLabel(row.tokenMint, symbolsByMint) ?? row.token;
                        const resolvedToken = row.tokenMint
                          ? resolveTokenByMint(row.tokenMint, issuedTokensByMint, tokenSymbol)
                          : null;
                        const amountLabel =
                          row.amount === "—"
                            ? "—"
                            : formatDisplayAmount(row.amount, "", locale).trim();
                        const mobileAmountLabel =
                          row.amount === "—"
                            ? "—"
                            : formatDisplayAmount(row.amount, tokenSymbol, locale);

                        return (
                          <TableRow key={row.id}>
                            <TableCell className="pl-6 text-secondary">
                              {timeTooltip ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="capitalize">{timeLabel}</span>
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
                              <div className="min-w-0">
                                <div className="truncate font-medium">{row.type}</div>
                                <div className="mt-1 truncate text-xs text-tertiary">
                                  {mobileAmountLabel}
                                </div>
                                <ActivityAddress
                                  row={row}
                                  cluster={cluster}
                                  className="mt-1 truncate font-mono text-xs text-tertiary"
                                />
                              </div>
                            </TableCell>
                            <TableCell className="hidden font-medium md:table-cell">
                              {row.type}
                            </TableCell>
                            <TableCell className="hidden text-secondary md:table-cell">
                              <span className="flex min-w-0 items-center gap-2">
                                <TokenMark
                                  mint={resolvedToken ? resolvedToken.mint : null}
                                  symbol={tokenSymbol}
                                  logoUrl={resolvedToken?.metadataImageUrl}
                                  size="xs"
                                />
                                <span className="flex min-w-0 items-baseline gap-2">
                                  <TruncatedTableText value={tokenSymbol} className="truncate" />
                                  {resolvedToken?.tokenId ? (
                                    <Badge variant="outline" className="shrink-0">
                                      {t("Shared.SharedComponents.sdpMintedToken")}
                                    </Badge>
                                  ) : null}
                                </span>
                              </span>
                            </TableCell>
                            <TableCell className="hidden text-right text-secondary tabular-nums md:table-cell">
                              <div className="truncate">{amountLabel}</div>
                            </TableCell>
                            <TableCell className="hidden pr-6 font-mono text-xs text-secondary md:table-cell">
                              <ActivityAddress row={row} cluster={cluster} className="truncate" />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TooltipProvider>
              )}
            </CardContent>
          </Card>
        </div>
      </SectionEntry>
    </div>
  );
}
