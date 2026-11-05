"use client";

import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { Suspense, use } from "react";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  formatTotalBalance,
  resolveTotalBalance,
  resolveUsdBalanceValue,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import { formatDate } from "@/app/(session)/dashboard/[projectId]/payments/payments-presentation";
import {
  PAYMENTS_TABLE_CELL,
  PAYMENTS_TABLE_HEAD,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-table";
import { UnpricedHoldingsHint } from "@/app/(session)/dashboard/[projectId]/payments/unpriced-holdings-hint";
import { useWalletActions } from "@/app/(session)/dashboard/[projectId]/wallets/use-wallet-actions";
import { WalletMetadataCopyButton } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-address-copy-button";
import {
  truncateMiddle,
  walletSignersKey,
} from "@/app/(session)/dashboard/[projectId]/wallets/wallet-format-utils";
import {
  RecordBlock,
  RecordFact,
  RecordFactGrid,
  RecordStack,
  StateBand,
} from "@/components/refresh-record";
import { TokenMark } from "@/components/token-mark";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useWalletActivity } from "./use-wallet-activity";
import { WalletActivityTable } from "./wallet-activity-table";
import {
  type IssuedTokensByMint,
  symbolsByMint,
  type WalletBalancesResult,
  type WalletPageView,
} from "./wallet-detail.shared";

const RECENT_ACTIVITY = 5;

/** A part with nothing in it yet: what is missing and when it appears. */
export function EmptyNote({ title, children }: { title: string; children: string }) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <p className="text-body font-medium text-primary">{title}</p>
      <p className="max-w-[40em] text-body text-secondary">{children}</p>
    </div>
  );
}

function PartSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity.
        <div key={index} className="h-6 animate-pulse rounded-control bg-fill-subtle" />
      ))}
    </div>
  );
}

/**
 * Whether the wallet can sign, as the design heads every wallet's page; a wallet created in a
 * connection names the connection it signs through.
 */
function WalletStateBand({ wallet }: { wallet: WalletPageView }) {
  const t = useTranslations();
  const { flags } = useDashboardWorkspace();
  return wallet.isRuntimeExecutionAllowed ? (
    <StateBand tone="ok" state={t("DashboardCustody.walletStateActive")}>
      {t(walletSignersKey(flags))}
      {wallet.connection
        ? ` ${t("DashboardCustody.walletSignsThroughConnection", { connection: wallet.connection.label })}`
        : null}
    </StateBand>
  ) : (
    <StateBand tone="warn" state={t("DashboardCustody.restricted")}>
      {t("DashboardCustody.signingDisabledBody")}
    </StateBand>
  );
}

function BalanceFigure({ balancesPromise }: { balancesPromise: Promise<WalletBalancesResult> }) {
  const locale = useLocale();
  const { balances, error } = use(balancesPromise);
  if (error) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-amount font-medium text-tertiary">—</p>
        <p className="text-body text-tertiary">{error}</p>
      </div>
    );
  }
  return (
    <p
      className="flex items-center gap-2 text-amount font-medium text-primary tabular-nums"
      data-wallet-balance
    >
      {formatTotalBalance(resolveTotalBalance(balances), locale)}
      <UnpricedHoldingsHint balances={balances} />
    </p>
  );
}

function BalanceBlock({
  wallet,
  balancesPromise,
}: {
  wallet: WalletPageView;
  balancesPromise: Promise<WalletBalancesResult>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { flags } = useDashboardWorkspace();
  return (
    <RecordBlock title={t("DashboardCustody.balance")} quiet>
      <Suspense
        fallback={<div className="h-11 w-48 animate-pulse rounded-control bg-fill-subtle" />}
      >
        <BalanceFigure balancesPromise={balancesPromise} />
      </Suspense>
      {/* The design's facts under the figure: three to a row, four when a connection joins
          them, two on a phone, where Created moves to the end. */}
      <div className="mt-4">
        <RecordFactGrid columns={wallet.connection ? 4 : 3}>
          <RecordFact label={t("DashboardCustody.provider")}>
            <span className="truncate">{wallet.providerName}</span>
          </RecordFact>
          {wallet.connection ? (
            <RecordFact
              label={t("DashboardCustody.connection")}
              hint={t("DashboardCustody.walletConnectionInfo", { provider: wallet.providerName })}
            >
              {wallet.connection.href ? (
                <Link
                  href={wallet.connection.href}
                  className="inline-flex min-w-0 items-center gap-1 underline decoration-border-strong underline-offset-4 hover:decoration-current"
                >
                  <span className="truncate">{wallet.connection.label}</span>
                  <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
                </Link>
              ) : (
                <span className="truncate">{wallet.connection.label}</span>
              )}
            </RecordFact>
          ) : null}
          <RecordFact
            label={t("DashboardCustody.purpose")}
            hint={t(
              flags.issuance
                ? "DashboardCustody.walletPurposeInfo"
                : "DashboardCustody.walletPurposeInfoPayments"
            )}
          >
            {wallet.purposeLabel ? (
              <span className="truncate">{wallet.purposeLabel}</span>
            ) : (
              <span className="text-tertiary">{t("DashboardCustody.unknown")}</span>
            )}
          </RecordFact>
          <RecordFact label={t("DashboardCustody.created")} last>
            {formatDate(wallet.createdAt, locale) ?? "—"}
          </RecordFact>
          <RecordFact label={t("DashboardCustody.address")}>
            <span className="truncate tabular-nums" title={wallet.publicKey}>
              {truncateMiddle(wallet.publicKey, 5, 6)}
            </span>
            <WalletMetadataCopyButton
              value={wallet.publicKey}
              label={t("DashboardCustody.walletAddress")}
            />
          </RecordFact>
          <RecordFact
            label={t("DashboardCustody.walletId")}
            hint={t("DashboardCustody.walletIdInfo")}
          >
            <span className="truncate tabular-nums" title={wallet.walletId}>
              {truncateMiddle(wallet.walletId, 9, 6)}
            </span>
            <WalletMetadataCopyButton
              value={wallet.walletId}
              label={t("DashboardCustody.walletId")}
            />
          </RecordFact>
        </RecordFactGrid>
      </div>
    </RecordBlock>
  );
}

/** A mint is shown under its token when it is an address; a native balance may carry none. */
function isMintAddress(mint: string | undefined): mint is string {
  return typeof mint === "string" && mint.trim().length >= 32;
}

function TokensTable({
  balancesPromise,
  issuedTokensPromise,
  issuanceEnabled,
}: {
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
  issuanceEnabled: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const projectHref = useProjectHref();
  const { balances, error } = use(balancesPromise);
  const issued = use(issuedTokensPromise);
  if (error) return <p className="text-body text-tertiary">{error}</p>;
  if (balances.length === 0) {
    return (
      <EmptyNote title={t("DashboardCustody.walletNoTokensTitle")}>
        {t("DashboardCustody.walletNoTokensBody")}
      </EmptyNote>
    );
  }
  return (
    <div className="overflow-x-auto refresh:-mx-3">
      <Table
        className="min-w-[35rem] rounded-none border-0 [&_table]:table-fixed"
        data-wallet-tokens
      >
        <TableHeader>
          <TableRow>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[36%]")}>
              {t("DashboardCustody.walletToken")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[34%] text-right")}>
              {t("DashboardCustody.walletAmount")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[30%] text-right")}>
              {t("DashboardCustody.walletValue")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {balances.map((balance) => {
            const issuedToken = balance.token === "SOL" ? undefined : issued[balance.mint];
            const name = issuedToken?.name ?? balance.token;
            // The same valuation as the total above, so a row and the total never disagree.
            const usdValue = resolveUsdBalanceValue(balance);
            return (
              <TableRow key={`${balance.mint}-${balance.token}`}>
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <span className="flex min-w-0 items-center gap-2">
                    <TokenMark mint={balance.mint} symbol={balance.token} size="sm" />
                    {/* The name over its mint, which copies from a 42rem container. */}
                    <span className="flex min-w-0 flex-col gap-0.5">
                      {issuanceEnabled && issuedToken ? (
                        <Link
                          href={projectHref(`/dashboard/issuance/${issuedToken.id}`)}
                          className="inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline"
                        >
                          <span className="truncate">{name}</span>
                          <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
                        </Link>
                      ) : (
                        <span className="truncate font-medium text-primary" title={balance.mint}>
                          {name}
                        </span>
                      )}
                      {isMintAddress(balance.mint) ? (
                        <span
                          className="flex min-w-0 items-center gap-1 text-meta text-tertiary tabular-nums"
                          title={balance.mint}
                          data-wallet-token-mint
                        >
                          <span className="truncate">{truncateMiddle(balance.mint, 4, 4)}</span>
                          <span className="hidden @2xl:contents">
                            <WalletMetadataCopyButton
                              value={balance.mint}
                              label={t("DashboardCustody.walletTokenMint", { token: name })}
                            />
                          </span>
                        </span>
                      ) : null}
                    </span>
                  </span>
                </TableCell>
                <TableCell
                  className={cn(PAYMENTS_TABLE_CELL, "text-right text-primary tabular-nums")}
                >
                  {formatDisplayAmount(balance.uiAmount, balance.token, locale)}
                </TableCell>
                <TableCell
                  className={cn(PAYMENTS_TABLE_CELL, "text-right text-primary tabular-nums")}
                >
                  {usdValue === null ? (
                    <span className="text-tertiary">{t("DashboardCustody.walletNoPrice")}</span>
                  ) : (
                    formatCurrencyAmount(usdValue, locale)
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function TokensBlock({
  wallet,
  balancesPromise,
  issuedTokensPromise,
  issuanceEnabled,
}: {
  wallet: WalletPageView;
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
  issuanceEnabled: boolean;
}) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { isBusy, canRequestDevnetSol, requestDevnetSol } = useWalletActions({
    walletId: wallet.walletId,
  });
  // The faucet funds devnet, so it is offered on a sandbox project to a wallet that can sign,
  // and to an admin: funding is wallets.execute.
  const offersFaucet =
    sdpEnvironment === "sandbox" && wallet.isRuntimeExecutionAllowed && canRequestDevnetSol;
  return (
    <RecordBlock
      title={t("DashboardCustody.walletTokens")}
      aside={
        offersFaucet ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={isBusy}
            onClick={requestDevnetSol}
          >
            {t("DashboardCustody.requestDevnetSol")}
          </Button>
        ) : undefined
      }
    >
      <Suspense fallback={<PartSkeleton />}>
        <TokensTable
          balancesPromise={balancesPromise}
          issuedTokensPromise={issuedTokensPromise}
          issuanceEnabled={issuanceEnabled}
        />
      </Suspense>
    </RecordBlock>
  );
}

function RecentActivityRows({
  walletId,
  balancesPromise,
  issuedTokensPromise,
}: {
  walletId: string;
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
}) {
  const t = useTranslations();
  const { balances } = use(balancesPromise);
  const issued = use(issuedTokensPromise);
  const { data, error } = useWalletActivity(walletId);
  if (!data && !error) return <PartSkeleton />;
  if (!data || data.activityError) {
    return (
      <p className="text-body text-tertiary">
        {data?.activityError ?? t("DashboardCustody.walletActivityUnavailable")}
      </p>
    );
  }
  // A refresh that fails after the rows loaded keeps them, with a note, as the Activity tab does
  // (the block lays its children out in a column).
  const refreshFailed = error ? (
    <p className="text-meta text-tertiary">{t("DashboardCustody.walletActivityUnavailable")}</p>
  ) : null;
  const rows = data.activityRows;
  if (rows.length === 0) {
    return (
      <>
        {refreshFailed}
        <EmptyNote title={t("DashboardCustody.walletNoActivityTitle")}>
          {t("DashboardCustody.walletNoActivityBody")}
        </EmptyNote>
      </>
    );
  }
  return (
    <>
      {refreshFailed}
      <WalletActivityTable
        rows={rows.slice(0, RECENT_ACTIVITY)}
        symbols={symbolsByMint(balances, issued)}
      />
    </>
  );
}

/**
 * The wallet at a glance: whether it can sign, its balance and identity, what it holds, what
 * it did last.
 */
export function WalletOverviewTab({
  wallet,
  balancesPromise,
  issuedTokensPromise,
  issuanceEnabled,
  onViewAllActivity,
}: {
  wallet: WalletPageView;
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
  issuanceEnabled: boolean;
  onViewAllActivity: () => void;
}) {
  const t = useTranslations();
  return (
    <RecordStack>
      <WalletStateBand wallet={wallet} />
      <BalanceBlock wallet={wallet} balancesPromise={balancesPromise} />
      <TokensBlock
        wallet={wallet}
        balancesPromise={balancesPromise}
        issuedTokensPromise={issuedTokensPromise}
        issuanceEnabled={issuanceEnabled}
      />
      <RecordBlock
        title={t("DashboardCustody.recentActivity")}
        aside={
          <Button type="button" variant="outline" size="sm" onClick={onViewAllActivity}>
            {t("DashboardCustody.walletViewAllActivity")}
          </Button>
        }
      >
        <Suspense fallback={<PartSkeleton />}>
          <RecentActivityRows
            walletId={wallet.walletId}
            balancesPromise={balancesPromise}
            issuedTokensPromise={issuedTokensPromise}
          />
        </Suspense>
      </RecordBlock>
    </RecordStack>
  );
}
