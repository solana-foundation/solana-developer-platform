"use client";

import type {
  PaymentsDashboardWallet,
  PaymentTransferBatch,
  PaymentTransferRecipient,
  PaymentTransferSummary,
} from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import { Badge } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { StatusText, type StatusTone } from "@sdp/ui/status-text";
import { ArrowDownIcon, Link2Icon, ReceiptTextIcon, Repeat2Icon } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo } from "react";
import { TokenMark } from "@/components/token-mark";
import { ActionTile } from "@/components/ui/action-tile";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import {
  readDashboardRequest,
  useDashboardKeyScope,
  useDashboardRead,
  useDashboardSWR,
} from "@/lib/dashboard-swr";
import { filterEnabledRampProviderAccess } from "@/lib/provider-availability";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { PaymentsActivityPanels } from "./payments-activity-panels";
import {
  PAYMENT_COMMAND_ACTION_DESTINATIONS,
  PAYMENT_COMMAND_ACTIVITY_DESTINATIONS,
  PAYMENT_COMMAND_SUMMARY_DESTINATIONS,
} from "./payments-command-center.constants";
import {
  activityTransferTypes,
  depositLineKey,
  payLineKey,
  resolveCommandCenterCounterparty,
} from "./payments-command-center.utils";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsSummarySkeleton,
} from "./payments-command-center-skeletons";
import {
  formatCurrencyAmount,
  formatTokenAmount,
  formatTotalBalance,
  normalizeAggregateBalances,
  resolveTokenByMint,
  resolveTotalBalance,
  resolveTransferTokenLabel,
  resolveUsdBalanceValue,
  selectTopAggregateBalanceRows,
  shortenAddress,
  statusMessageKey,
} from "./payments-overview.utils";
import {
  ACTIVITY_KIND_MESSAGE_KEYS,
  activityKind,
  formatDecimalAmount,
  formatElapsedShort,
  formatSignedAmount,
  PAYMENT_STATUS_TONE,
  rampFiatSide,
  summarizeBatch,
} from "./payments-presentation";
import { paymentsQueryKeys } from "./payments-query-key";
import {
  transferBatchListResponseSchema,
  transferBatchResponseSchema,
  transferListResponseSchema,
} from "./payments-read-schemas";
import { recurringPaymentsListEnvelopeSchema } from "./recurring/recurring-payments.data";
import { paymentRequestsListResponseSchema } from "./requests/payment-requests-page.data";
import {
  useCounterparties,
  useIssuedTokens,
  useOrganizationProviderAccess,
  useWalletAggregate,
  useWalletSummaries,
} from "./shared-reads";
import { UnpricedHoldingsHint } from "./unpriced-holdings-hint";

type Translate = ReturnType<typeof useTranslations>;

const ACTIVITY_ROW_COUNT = 5;

/** What the deployment runs, as the page's flags and release channel say. */
export interface PaymentsCommandCenterModules {
  /** Ramps offered here (`isRampsEnabled`): the Pay and Deposit lines name fiat. */
  rampsOffered: boolean;
  /** The release channel runs Ramps: activity lists ramps beside transfers. */
  rampsInReleaseChannel: boolean;
  complianceInReleaseChannel: boolean;
  issuanceEnabled: boolean;
  /** The ramp providers the channel-capped flags leave on (`getEnabledRampProviders`). */
  enabledRampProviders: readonly RampProviderId[];
}

interface RecentBatch {
  batch: PaymentTransferBatch;
  recipients: readonly PaymentTransferRecipient[];
}

/** The recent batches and each one's recipients, which turn "partially failed" into "1 of 8 failed". */
async function readRecentBatches(key: DashboardRequestKey): Promise<RecentBatch[]> {
  const scope = { projectId: key[0], mode: key[1] };
  const list = await readDashboardRequest(key, transferBatchListResponseSchema);
  return Promise.all(
    list.data.map(async (batch) => {
      const detail = await readDashboardRequest(
        paymentsQueryKeys.transferBatch(scope, batch.id),
        transferBatchResponseSchema
      );
      return { batch, recipients: detail.data.recipients };
    })
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations();
  return (
    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
      {t("Shared.SharedComponents.retry")}
    </Button>
  );
}

function MoveMoneyActions({ modules }: { modules: PaymentsCommandCenterModules }) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  // Every tile starts a payment; a read-only member has none to start.
  if (!useCanWrite()) {
    return null;
  }
  return (
    <section
      className="grid min-w-0 grid-cols-2 content-start gap-2"
      aria-label={t("DashboardPayments.commandCenter.moveMoney")}
      data-payments-overview-section="actions"
    >
      <ActionTile
        href={projectHref(PAYMENT_COMMAND_ACTION_DESTINATIONS.pay)}
        icon={ReceiptTextIcon}
        label={t("DashboardPayments.pay")}
        description={t(
          payLineKey({
            ramps: modules.rampsOffered,
            compliance: modules.complianceInReleaseChannel,
          })
        )}
      />
      <ActionTile
        href={projectHref(PAYMENT_COMMAND_ACTION_DESTINATIONS.deposit)}
        icon={ArrowDownIcon}
        label={t("DashboardPayments.deposit")}
        description={t(depositLineKey(modules.rampsOffered))}
      />
      <ActionTile
        href={projectHref(PAYMENT_COMMAND_ACTION_DESTINATIONS.request)}
        icon={Link2Icon}
        label={t("DashboardPayments.newDesign.commandCenter.requestPayment")}
        description={t("DashboardPayments.newDesign.commandCenter.requestPaymentDescription")}
      />
      <ActionTile
        href={projectHref(PAYMENT_COMMAND_ACTION_DESTINATIONS.schedule)}
        icon={Repeat2Icon}
        label={t("DashboardPayments.commandCenter.schedule")}
        description={t("DashboardPayments.newDesign.commandCenter.scheduleDescription")}
      />
    </section>
  );
}

function AvailableBalance({ issuanceEnabled }: { issuanceEnabled: boolean }) {
  const t = useTranslations();
  const locale = useLocale();
  const aggregate = useWalletAggregate();
  const issuedTokens = useIssuedTokens(issuanceEnabled);
  const issuedTokensByMint = useMemo(
    () => Object.fromEntries((issuedTokens.data ?? []).map((token) => [token.mintAddress, token])),
    [issuedTokens.data]
  );
  if (aggregate.data === undefined && aggregate.error === undefined) {
    return <PaymentsBalanceSkeleton />;
  }
  const heading = (
    <h2 className="text-meta text-secondary">
      {t("DashboardPayments.commandCenter.availableBalance")}
    </h2>
  );
  if (aggregate.data === undefined) {
    return (
      <section className="min-w-0" data-payments-overview-section="balance">
        {heading}
        <p className="mt-3 text-body text-tertiary">
          {t("DashboardPayments.commandCenter.balanceUnavailable")}
        </p>
        <div className="mt-3">
          <RetryButton onRetry={() => void aggregate.mutate()} />
        </div>
      </section>
    );
  }

  const aggregateBalances = aggregate.data.balances;
  const balances = normalizeAggregateBalances(aggregateBalances);
  const topBalances = selectTopAggregateBalanceRows(balances, {}).slice(0, 3);
  // The aggregate answered, so no rows at all means nothing is held: $0.00, not a missing total.
  const totalBalance = aggregateBalances.length === 0 ? 0 : resolveTotalBalance(aggregateBalances);
  return (
    <section className="min-w-0" data-payments-overview-section="balance">
      {heading}
      <p className="mt-1.5 flex items-center gap-2 text-amount font-medium text-primary tabular-nums">
        {formatTotalBalance(totalBalance, locale)}
        <UnpricedHoldingsHint balances={aggregateBalances} />
      </p>
      {topBalances.length > 0 ? (
        // 52px pitch: a 36px mark beside a 16px name over its 13px amount, 16px apart.
        <ul className="mt-8 space-y-4">
          {topBalances.map((balance) => {
            const resolved = resolveTokenByMint(balance.mint, issuedTokensByMint, balance.token);
            const label =
              resolved.tokenName.length > 12
                ? shortenAddress(resolved.tokenName)
                : resolved.tokenName;
            const usdValue = resolveUsdBalanceValue(balance);
            return (
              <li
                key={`${balance.token}-${balance.mint}`}
                className="flex min-w-0 items-center gap-4"
              >
                <TokenMark
                  mint={resolved.mint}
                  symbol={resolved.tokenName}
                  logoUrl={resolved.metadataImageUrl}
                  size="lg"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="truncate text-field leading-5 text-primary"
                      title={resolved.tokenName}
                    >
                      {label}
                    </span>
                    {resolved.tokenId ? (
                      <Badge variant="outline" className="shrink-0">
                        {t("Shared.SharedComponents.sdpMintedToken")}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="block text-meta text-secondary tabular-nums">
                    {formatTokenAmount(balance.uiAmount, locale)}
                  </span>
                </span>
                {usdValue === null ? null : (
                  <span className="shrink-0 text-body text-primary tabular-nums">
                    {formatCurrencyAmount(usdValue, locale)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function countLabel(t: Translate, key: string, count: number | null): string {
  return t(`${key}.${count === 1 ? "one" : "other"}` as MessageKey);
}

/**
 * The one-line census under the balance: contacts, open requests, active schedules and
 * enabled providers. Each count links to where it is managed; a core count that failed to load
 * reads "—" rather than a misleading zero, and providers drop out where no ramp provider is
 * offered or their availability can't be read at all.
 */
function PaymentsSummaryLine({ modules }: { modules: PaymentsCommandCenterModules }) {
  const t = useTranslations();
  const providerAccess = useOrganizationProviderAccess();
  // Null where the dashboard offers no ramp provider (stable runs no Ramps), or where access
  // can't be read: the count drops out rather than read as none.
  const providerCount =
    !modules.rampsOffered || providerAccess.data === undefined
      ? null
      : Object.values(
          filterEnabledRampProviderAccess(providerAccess.data.ramps, modules.enabledRampProviders)
        ).filter((access) => access.entitled && access.configured && access.enabled).length;
  const projectHref = useProjectHref();
  const scope = useDashboardKeyScope();
  const contacts = useCounterparties({ page: 1, pageSize: 1 });
  const openRequests = useDashboardRead(
    paymentsQueryKeys.paymentRequests(scope, { page: 1, pageSize: 1, status: "awaiting_payment" }),
    paymentRequestsListResponseSchema
  );
  const schedules = useDashboardRead(
    paymentsQueryKeys.recurringPayments(scope, { page: 1, pageSize: 1, status: "active" }),
    recurringPaymentsListEnvelopeSchema
  );
  const counts = [contacts, openRequests, schedules];
  const providerAccessPending =
    modules.rampsOffered && providerAccess.data === undefined && providerAccess.error === undefined;
  if (
    providerAccessPending ||
    counts.every((read) => read.data === undefined && read.error === undefined)
  ) {
    return <PaymentsSummarySkeleton />;
  }
  const base = "DashboardPayments.commandCenter.summary";
  const items = [
    {
      key: "contacts",
      href: PAYMENT_COMMAND_SUMMARY_DESTINATIONS.contacts,
      count: contacts.data === undefined ? null : contacts.data.total,
    },
    {
      key: "openRequests",
      href: PAYMENT_COMMAND_SUMMARY_DESTINATIONS.openRequests,
      count: openRequests.data === undefined ? null : openRequests.data.data.total,
    },
    {
      key: "schedules",
      href: PAYMENT_COMMAND_SUMMARY_DESTINATIONS.schedules,
      count: schedules.data === undefined ? null : schedules.data.data.total,
    },
    ...(providerCount === null
      ? []
      : [
          {
            key: "providers",
            href: PAYMENT_COMMAND_SUMMARY_DESTINATIONS.providers,
            count: providerCount,
          },
        ]),
  ];
  const failedCounts = counts.filter((read) => read.error !== undefined);
  return (
    <section
      className="mt-10 border-t border-border-default pt-6"
      data-payments-overview-section="summary"
    >
      {/* The counts read at 16px over their 13px words, on one baseline. */}
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-meta text-secondary">
        {items.map((item, index) => (
          <Fragment key={item.key}>
            {index > 0 ? (
              <span aria-hidden="true" className="text-tertiary">
                ·
              </span>
            ) : null}
            <Link href={projectHref(item.href)} className="transition-colors hover:text-primary">
              <span className="text-field font-medium text-primary tabular-nums">
                {item.count ?? "—"}
              </span>{" "}
              {countLabel(t, `${base}.${item.key}`, item.count)}
            </Link>
          </Fragment>
        ))}
      </p>
      {failedCounts.length > 0 ? (
        <div className="mt-3">
          <RetryButton
            onRetry={() => {
              for (const read of failedCounts) void read.mutate();
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

function ActivityRow({
  href,
  name,
  detail,
  status,
  amount,
  when,
}: {
  href: string;
  name: string;
  detail: string;
  status: { label: string; tone: StatusTone };
  amount: string | null;
  when: string | null;
}) {
  return (
    <li className="border-b border-border-subtle">
      {/* 61px rows, ruled beneath: a 14px line over a 13px line, 12px above and below. */}
      <Link
        href={href}
        className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-0.5 rounded-control px-2 py-3 transition-colors hover:bg-fill-subtle sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]"
      >
        <span className="col-start-1 row-start-1 min-w-0">
          <span className="block truncate text-body text-primary" title={name}>
            {name}
          </span>
          <span className="block truncate text-meta text-secondary" title={detail}>
            {detail}
          </span>
        </span>
        <StatusText
          tone={status.tone}
          className="col-start-1 row-start-2 truncate text-meta leading-5 sm:col-start-2 sm:row-start-1"
        >
          {status.label}
        </StatusText>
        <span className="col-start-2 row-start-1 min-w-0 text-right sm:col-start-3">
          <span className="block text-body text-primary tabular-nums">{amount ?? "—"}</span>
          {when ? <span className="block text-meta text-tertiary">{when}</span> : null}
        </span>
      </Link>
    </li>
  );
}

function ActivityList({
  rows,
  empty,
  unavailable,
  onRetry,
  viewAll,
}: {
  rows: readonly Parameters<typeof ActivityRow>[0][] | null;
  /** The design's empty state: what would show here, and the one way on from it. */
  empty: { title: string; description: string; actionLabel: string };
  unavailable: string;
  onRetry: () => void;
  viewAll: { href: string; label: string };
}) {
  if (rows !== null && rows.length === 0) {
    return (
      <ListEmptyState
        className="py-12"
        message={empty.title}
        description={empty.description}
        action={
          <Button asChild variant="outline">
            <Link href={viewAll.href}>{empty.actionLabel}</Link>
          </Button>
        }
      />
    );
  }
  return (
    <>
      {rows === null ? (
        <div className="flex flex-col items-start gap-3 py-8">
          <p className="text-body text-tertiary">{unavailable}</p>
          <RetryButton onRetry={onRetry} />
        </div>
      ) : (
        <ul>
          {rows.map((row) => (
            <ActivityRow key={row.href + row.name + (row.when ?? "")} {...row} />
          ))}
        </ul>
      )}
      <Button asChild variant="outline" size="sm" className="mt-6">
        <Link href={viewAll.href}>{viewAll.label}</Link>
      </Button>
    </>
  );
}

function walletName(
  walletsById: ReadonlyMap<string, PaymentsDashboardWallet>,
  custodyWalletId: string | null
): string | null {
  if (!custodyWalletId) return null;
  const wallet = walletsById.get(custodyWalletId);
  if (!wallet) return null;
  return wallet.label ?? shortenAddress(wallet.publicKey);
}

function transferRow(
  transfer: PaymentTransferSummary,
  context: {
    t: Translate;
    locale: string;
    timeZone: string;
    projectHref: (path: string) => string;
    walletsById: ReadonlyMap<string, PaymentsDashboardWallet>;
    issuedTokenSymbolsByMint: Readonly<Record<string, string>>;
  }
): Parameters<typeof ActivityRow>[0] {
  const { t, locale, timeZone, projectHref, walletsById, issuedTokenSymbolsByMint } = context;
  const counterparty = resolveCommandCenterCounterparty(transfer);
  const direction =
    transfer.direction === "inbound" || transfer.direction === "outbound"
      ? transfer.direction
      : undefined;
  // Every row leads with what moved through the wallet, so buys, sales and sends read alike;
  // a ramp's fiat side rides in the detail, and leads only while a buy's tokens are unknown.
  const isRamp = transfer.type === "onramp" || transfer.type === "offramp";
  const rampDirection: "inbound" | "outbound" =
    direction ?? (transfer.type === "onramp" ? "inbound" : "outbound");
  // A completed sale shows what the provider reports it paid, as its receipt does.
  const fiatSide = isRamp ? rampFiatSide(transfer) : null;
  const rampFiat = fiatSide
    ? { amount: fiatSide.amount, unit: fiatSide.currency.toUpperCase() }
    : null;
  const lead = transfer.amount
    ? {
        amount: transfer.amount,
        unit: resolveTransferTokenLabel(transfer.token, issuedTokenSymbolsByMint),
        direction: isRamp ? rampDirection : direction,
      }
    : rampFiat && { ...rampFiat, direction: rampDirection };
  const amount = lead ? formatSignedAmount(lead.amount, lead.direction, lead.unit, locale) : null;
  const fiat = rampFiat ? `${formatDecimalAmount(rampFiat.amount, locale)} ${rampFiat.unit}` : null;
  const wallet = walletName(walletsById, transfer.custodyWalletId);
  const kind = t(ACTIVITY_KIND_MESSAGE_KEYS[activityKind(transfer)]);
  const detail = [kind, wallet, transfer.amount ? fiat : null].filter(Boolean).join(" · ");
  return {
    href: projectHref(`/dashboard/payments/transactions?search=${encodeURIComponent(transfer.id)}`),
    name: counterparty.length > 24 ? shortenAddress(counterparty) : counterparty,
    detail,
    status: {
      label: t(statusMessageKey(transfer.status)),
      tone: PAYMENT_STATUS_TONE[transfer.status],
    },
    amount,
    when: formatElapsedShort(transfer.createdAt, locale, timeZone),
  };
}

function batchRow(
  batch: PaymentTransferBatch,
  recipients: readonly PaymentTransferRecipient[] | undefined,
  context: {
    t: Translate;
    locale: string;
    timeZone: string;
    projectHref: (path: string) => string;
    walletsById: ReadonlyMap<string, PaymentsDashboardWallet>;
    issuedTokenSymbolsByMint: Readonly<Record<string, string>>;
  }
): Parameters<typeof ActivityRow>[0] {
  const { t, locale, timeZone, projectHref, walletsById, issuedTokenSymbolsByMint } = context;
  const summary = summarizeBatch(batch, recipients);
  const wallet = walletName(walletsById, batch.sourceCustodyWalletId);
  const kind = t(ACTIVITY_KIND_MESSAGE_KEYS.batch);
  return {
    href: projectHref(PAYMENT_COMMAND_ACTIVITY_DESTINATIONS.batches),
    name:
      batch.externalId ??
      t("DashboardPayments.commandCenter.batchFallbackName", { id: batch.id.slice(-6) }),
    detail: wallet ? `${kind} · ${wallet}` : kind,
    status: { label: t(summary.key, summary.values), tone: summary.tone },
    amount: formatSignedAmount(
      batch.totalAmount ?? undefined,
      "outbound",
      resolveTransferTokenLabel(batch.token, issuedTokenSymbolsByMint),
      locale
    ),
    when: formatElapsedShort(batch.createdAt, locale, timeZone),
  };
}

function Activity({ modules }: { modules: PaymentsCommandCenterModules }) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const projectHref = useProjectHref();
  const scope = useDashboardKeyScope();
  const transfers = useDashboardRead(
    paymentsQueryKeys.recentTransfers(scope, {
      pageSize: ACTIVITY_ROW_COUNT,
      types: activityTransferTypes(modules.rampsInReleaseChannel),
    }),
    transferListResponseSchema
  );
  const batches = useDashboardSWR(
    paymentsQueryKeys.recentTransferBatches(scope, { pageSize: ACTIVITY_ROW_COUNT }),
    readRecentBatches
  );
  const issuedTokens = useIssuedTokens(modules.issuanceEnabled);
  const wallets = useWalletSummaries({ includeBalances: false });
  if (
    (transfers.data === undefined && transfers.error === undefined) ||
    (batches.data === undefined && batches.error === undefined)
  ) {
    return <PaymentsActivitySkeleton />;
  }
  const context = {
    t,
    locale,
    timeZone,
    projectHref,
    walletsById: new Map((wallets.data ?? []).map((wallet) => [wallet.id, wallet])),
    issuedTokenSymbolsByMint: Object.fromEntries(
      (issuedTokens.data ?? []).map((token) => [token.mintAddress, token.symbol])
    ),
  };
  const unavailable = t("DashboardPayments.commandCenter.activityUnavailable");

  return (
    <section className="min-w-0" data-payments-overview-section="activity">
      <PaymentsActivityPanels
        title={t("DashboardPayments.commandCenter.activity")}
        switchLabel={t("DashboardPayments.commandCenter.activity")}
        transfersLabel={t("DashboardPayments.commandCenter.transfers")}
        batchesLabel={t("DashboardPayments.commandCenter.batches")}
        transfers={
          <ActivityList
            rows={
              transfers.data === undefined
                ? null
                : transfers.data.data.map((transfer) => transferRow(transfer, context))
            }
            empty={{
              title: t("DashboardPayments.commandCenter.noTransfersTitle"),
              description: t("DashboardPayments.commandCenter.noTransfersDescription"),
              actionLabel: t("DashboardPayments.commandCenter.openTransactions"),
            }}
            unavailable={unavailable}
            onRetry={() => void transfers.mutate()}
            viewAll={{
              href: projectHref(PAYMENT_COMMAND_ACTIVITY_DESTINATIONS.transfers),
              label: t("DashboardPayments.viewAllTransactions"),
            }}
          />
        }
        batches={
          <ActivityList
            rows={
              batches.data === undefined
                ? null
                : batches.data.map(({ batch, recipients }) => batchRow(batch, recipients, context))
            }
            empty={{
              title: t("DashboardPayments.commandCenter.noBatchesTitle"),
              description: t("DashboardPayments.commandCenter.noBatchesDescription"),
              actionLabel: t("DashboardPayments.commandCenter.openTransactions"),
            }}
            unavailable={unavailable}
            onRetry={() => void batches.mutate()}
            viewAll={{
              href: projectHref(PAYMENT_COMMAND_ACTIVITY_DESTINATIONS.batches),
              label: t("DashboardPayments.commandCenter.viewAllBatches"),
            }}
          />
        }
      />
    </section>
  );
}

export function PaymentsCommandCenter({ modules }: { modules: PaymentsCommandCenterModules }) {
  return (
    <div className="flex min-w-0 flex-col gap-16" data-payments-command-center>
      <div className="grid min-w-0 gap-10 lg:grid-cols-2 lg:gap-12">
        <div className="min-w-0">
          <AvailableBalance issuanceEnabled={modules.issuanceEnabled} />
          <PaymentsSummaryLine modules={modules} />
        </div>
        <MoveMoneyActions modules={modules} />
      </div>
      <Activity modules={modules} />
    </div>
  );
}
