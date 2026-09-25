"use client";

import Link from "next/link";
import { Suspense, use } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { truncateMiddle } from "@/app/dashboard/custody/wallet-format-utils";
import {
  RecordBlock,
  RecordColumns,
  RecordRow,
  RecordStack,
  StateBand,
} from "@/components/refresh-record";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  resolveTotalBalance,
} from "../../payments/payments-overview.utils";
import { formatDate } from "../../payments/payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "../../payments/payments-table";
import { useWalletActions } from "../use-wallet-actions";
import { useWalletActivity } from "./use-wallet-activity";
import { WalletActivityTable } from "./wallet-activity-table";
import {
  type IssuedTokensByMint,
  policySummaryLine,
  symbolsByMint,
  type WalletBalancesResult,
  type WalletPageView,
  type WalletPolicyResult,
  walletPolicyHref,
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

/** Whether the wallet can sign, as the design heads every wallet's page. */
export function WalletStateBand({ wallet }: { wallet: WalletPageView }) {
  const t = useTranslations();
  return wallet.isRuntimeExecutionAllowed ? (
    <StateBand tone="ok" state={t("DashboardCustody.walletStateActive")}>
      {t("DashboardCustody.walletStateActiveBody")}
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
    <p className="text-amount font-medium text-primary tabular-nums" data-wallet-balance>
      {formatCurrencyAmount(resolveTotalBalance(balances), locale)}
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
  return (
    <RecordBlock title={t("DashboardCustody.balance")} quiet>
      <Suspense
        fallback={<div className="h-11 w-48 animate-pulse rounded-control bg-fill-subtle" />}
      >
        <BalanceFigure balancesPromise={balancesPromise} />
      </Suspense>
      <div className="mt-4">
        <RecordColumns>
          <dl>
            <RecordRow label={t("DashboardCustody.provider")}>{wallet.providerName}</RecordRow>
            <RecordRow
              label={t("DashboardCustody.purpose")}
              hint={t("DashboardCustody.walletPurposeInfo")}
            >
              {wallet.purposeLabel ?? (
                <span className="text-tertiary">{t("DashboardCustody.unknown")}</span>
              )}
            </RecordRow>
            <RecordRow label={t("DashboardCustody.created")}>
              {formatDate(wallet.createdAt, locale) ?? "—"}
            </RecordRow>
          </dl>
          <dl>
            <RecordRow label={t("DashboardCustody.address")}>
              <span className="truncate tabular-nums" title={wallet.publicKey}>
                {truncateMiddle(wallet.publicKey, 5, 6)}
              </span>
              <WalletMetadataCopyButton
                value={wallet.publicKey}
                label={t("DashboardCustody.walletAddress")}
              />
            </RecordRow>
            <RecordRow
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
            </RecordRow>
            {wallet.connection ? (
              <RecordRow label={t("DashboardCustody.connection")}>
                {wallet.connection.href ? (
                  <Link href={wallet.connection.href} className="truncate hover:underline">
                    {wallet.connection.label}
                  </Link>
                ) : (
                  <span className="truncate">{wallet.connection.label}</span>
                )}
              </RecordRow>
            ) : null}
          </dl>
        </RecordColumns>
      </div>
    </RecordBlock>
  );
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
        className="min-w-[560px] rounded-none border-0 [&_table]:table-fixed"
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
            return (
              <TableRow key={`${balance.mint}-${balance.token}`}>
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <span className="flex min-w-0 items-center gap-2 font-medium text-primary">
                    <TokenMark mint={balance.mint} symbol={balance.token} size="sm" />
                    {issuanceEnabled && issuedToken ? (
                      <Link
                        href={`/dashboard/issuance/${issuedToken.id}`}
                        className="truncate hover:underline"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span className="truncate" title={balance.mint}>
                        {name}
                      </span>
                    )}
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
                  {balance.usdValue === undefined ? (
                    <span className="text-tertiary">{t("DashboardCustody.walletNoPrice")}</span>
                  ) : (
                    formatCurrencyAmount(balance.usdValue, locale)
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
  const { isBusy, requestDevnetSol } = useWalletActions({
    walletId: wallet.walletId,
    walletAddress: wallet.publicKey,
  });
  // The faucet funds devnet, so it is offered on a sandbox project to a wallet that can sign.
  const offersFaucet = sdpEnvironment === "sandbox" && wallet.isRuntimeExecutionAllowed;
  return (
    <RecordBlock
      title={t("DashboardCustody.walletTokens")}
      aside={
        offersFaucet ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy}
            onClick={requestDevnetSol}
          >
            {isBusy ? t("DashboardCustody.requesting") : t("DashboardCustody.requestDevnetSol")}
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
  if (error || data?.activityError) {
    return (
      <p className="text-body text-tertiary">
        {data?.activityError ?? t("DashboardCustody.walletActivityUnavailable")}
      </p>
    );
  }
  const rows = data?.activityRows ?? [];
  if (rows.length === 0) {
    return (
      <EmptyNote title={t("DashboardCustody.walletNoActivityTitle")}>
        {t("DashboardCustody.walletNoActivityBody")}
      </EmptyNote>
    );
  }
  return (
    <WalletActivityTable
      rows={rows.slice(0, RECENT_ACTIVITY)}
      symbols={symbolsByMint(balances, issued)}
    />
  );
}

function PolicySummary({
  policyPromise,
  balancesPromise,
  issuedTokensPromise,
}: {
  policyPromise: Promise<WalletPolicyResult>;
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { policy, error } = use(policyPromise);
  const { balances } = use(balancesPromise);
  const issued = use(issuedTokensPromise);
  const line = policy
    ? policySummaryLine(policy, symbolsByMint(balances, issued), locale, t)
    : null;
  return (
    <p className="max-w-[40em] text-body text-secondary">
      {error ?? line ?? t("DashboardCustody.walletPolicyNone")}
    </p>
  );
}

function PolicyAction({
  walletId,
  policyPromise,
}: {
  walletId: string;
  policyPromise: Promise<WalletPolicyResult>;
}) {
  const t = useTranslations();
  const { policy } = use(policyPromise);
  const hasProfile = Boolean(policy?.controlProfile);
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={walletPolicyHref(walletId)}>
        {hasProfile
          ? t("DashboardCustody.walletEditPolicy")
          : t("DashboardCustody.walletSetUpPolicy")}
      </Link>
    </Button>
  );
}

/**
 * The wallet at a glance: whether it can sign, its balance and identity, what it holds, what
 * it did last, and the policy it runs under.
 */
export function WalletOverviewTab({
  wallet,
  balancesPromise,
  policyPromise,
  issuedTokensPromise,
  issuanceEnabled,
  onViewAllActivity,
}: {
  wallet: WalletPageView;
  balancesPromise: Promise<WalletBalancesResult>;
  policyPromise: Promise<WalletPolicyResult> | null;
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
      {policyPromise ? (
        <RecordBlock
          title={t("DashboardCustody.walletPolicyTitle")}
          aside={
            <Suspense fallback={null}>
              <PolicyAction walletId={wallet.walletId} policyPromise={policyPromise} />
            </Suspense>
          }
        >
          <Suspense fallback={<PartSkeleton rows={1} />}>
            <PolicySummary
              policyPromise={policyPromise}
              balancesPromise={balancesPromise}
              issuedTokensPromise={issuedTokensPromise}
            />
          </Suspense>
        </RecordBlock>
      ) : null}
    </RecordStack>
  );
}
