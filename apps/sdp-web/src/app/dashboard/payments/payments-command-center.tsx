import type {
  PaymentsDashboardWallet,
  PaymentTransferBatch,
  PaymentTransferRecipient,
  PaymentTransferSummary,
} from "@sdp/types";
import { ArrowDownIcon, Link2Icon, ReceiptTextIcon, Repeat2Icon } from "lucide-react";
import Link from "next/link";
import { Fragment, Suspense } from "react";
import { TokenMark } from "@/components/token-mark";
import { ActionTile } from "@/components/ui/action-tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import { getEnabledRampProviders } from "@/flags/ramps";
import type { MessageKey } from "@/i18n/messages";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import {
  fetchProviderAvailability,
  filterEnabledRampProviderAccess,
} from "@/lib/provider-availability";
import { createTimedTrace } from "@/lib/request-tracing";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchCounterparties } from "./counterparty/counterparty-page.data";
import { PaymentsActivityPanels } from "./payments-activity-panels";
import {
  PAYMENT_COMMAND_ACTION_DESTINATIONS,
  PAYMENT_COMMAND_ACTIVITY_DESTINATIONS,
  PAYMENT_COMMAND_SUMMARY_DESTINATIONS,
} from "./payments-command-center.constants";
import { resolveCommandCenterCounterparty } from "./payments-command-center.utils";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsSummarySkeleton,
} from "./payments-command-center-skeletons";
import {
  formatCurrencyAmount,
  formatTokenAmount,
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
  fetchIssuedTokensByMint,
  fetchPaymentsAggregate,
  fetchPaymentsIssuedTokenSymbols,
  fetchPaymentsWallets,
  fetchPaymentTransfers,
  fetchTransferBatches,
  fetchTransferBatchRecipients,
} from "./payments-page.data";
import {
  ACTIVITY_KIND_MESSAGE_KEYS,
  activityKind,
  formatElapsedShort,
  formatSignedAmount,
  PAYMENT_STATUS_TONE,
  summarizeBatch,
} from "./payments-presentation";
import { fetchRecurringPayments } from "./recurring/recurring-payments.data";
import { fetchPaymentRequests } from "./requests/payment-requests-page.data";

type ApiClientPromise = Promise<{ request: SdpApiClient["request"] }>;
type Translate = Awaited<ReturnType<typeof getTranslations>>;

const ACTIVITY_ROW_COUNT = 5;
// Transfers and batches are separate lists here, so the transfer list leaves batch parents out.
const NON_BATCH_TRANSFER_TYPES = ["transfer", "onramp", "offramp"] as const;

async function MoveMoneyActions() {
  const t = await getTranslations();
  return (
    <section
      className="grid min-w-0 grid-cols-2 content-start gap-2"
      aria-label={t("DashboardPayments.commandCenter.moveMoney")}
      data-payments-overview-section="actions"
    >
      <ActionTile
        href={PAYMENT_COMMAND_ACTION_DESTINATIONS.pay}
        icon={ReceiptTextIcon}
        label={t("DashboardPayments.pay")}
        description={t("DashboardPayments.commandCenter.payDescription")}
      />
      <ActionTile
        href={PAYMENT_COMMAND_ACTION_DESTINATIONS.deposit}
        icon={ArrowDownIcon}
        label={t("DashboardPayments.deposit")}
        description={t("DashboardPayments.commandCenter.depositDescription")}
      />
      <ActionTile
        href={PAYMENT_COMMAND_ACTION_DESTINATIONS.request}
        icon={Link2Icon}
        label={t("DashboardPayments.commandCenter.requestPayment")}
        description={t("DashboardPayments.commandCenter.requestPaymentDescription")}
      />
      <ActionTile
        href={PAYMENT_COMMAND_ACTION_DESTINATIONS.schedule}
        icon={Repeat2Icon}
        label={t("DashboardPayments.commandCenter.schedule")}
        description={t("DashboardPayments.commandCenter.scheduleDescription")}
      />
    </section>
  );
}

async function AvailableBalance({ apiClientPromise }: { apiClientPromise: ApiClientPromise }) {
  const [{ request }, t, locale] = await Promise.all([
    apiClientPromise,
    getTranslations(),
    getRequestLocale(),
  ]);
  const trace = createTimedTrace("dashboard.payments.overview.balance");
  const [result, issuedTokensByMint] = await Promise.all([
    trace.step("fetch_aggregate", () => fetchPaymentsAggregate(request)),
    trace.step("fetch_issued_token_symbols", () => fetchIssuedTokensByMint(request)),
  ]);
  trace.log({
    ok: result.ok,
    requestCount: 2,
    responseBytes: new TextEncoder().encode(JSON.stringify(result.data ?? null)).byteLength,
  });
  const heading = (
    <h2 className="text-body text-secondary">
      {t("DashboardPayments.commandCenter.availableBalance")}
    </h2>
  );
  if (!result.ok || !result.data) {
    return (
      <section className="min-w-0" data-payments-overview-section="balance">
        {heading}
        <p className="mt-3 text-body text-tertiary">
          {t("DashboardPayments.commandCenter.balanceUnavailable")}
        </p>
      </section>
    );
  }

  const balances = normalizeAggregateBalances(result.data.balances ?? []);
  const topBalances = selectTopAggregateBalanceRows(balances, {}).slice(0, 3);
  return (
    <section className="min-w-0" data-payments-overview-section="balance">
      {heading}
      <p className="mt-1 text-amount font-medium text-primary tabular-nums">
        {formatCurrencyAmount(resolveTotalBalance(balances), locale)}
      </p>
      {topBalances.length > 0 ? (
        <ul className="mt-8 space-y-5">
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
                    <span className="truncate text-body text-primary" title={resolved.tokenName}>
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
                  <span className="shrink-0 text-body font-medium text-primary tabular-nums">
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
 * enabled providers. Each count links to where it is managed; a count that failed to load
 * reads "—" rather than a misleading zero.
 */
async function PaymentsSummaryLine({
  apiClientPromise,
  organizationId,
}: {
  apiClientPromise: ApiClientPromise;
  organizationId: string;
}) {
  const [{ request }, t] = await Promise.all([apiClientPromise, getTranslations()]);
  const trace = createTimedTrace("dashboard.payments.overview.summary");
  const [[counterparties, requests, recurring, providerAccess], enabledRampProviders] =
    await Promise.all([
      trace.step("fetch_summary_counts", () =>
        Promise.all([
          fetchCounterparties(request, { page: 1, pageSize: 1 }),
          fetchPaymentRequests(request, { pageSize: 1, status: "awaiting_payment" }),
          fetchRecurringPayments(request, t, { page: 1, pageSize: 1, status: "active" }),
          fetchProviderAvailability(request, organizationId).catch(() => null),
        ])
      ),
      getEnabledRampProviders(),
    ]);
  const providerCount = providerAccess
    ? Object.values(
        filterEnabledRampProviderAccess(providerAccess.rampProviderAccess, enabledRampProviders)
      ).filter((access) => access.entitled && access.configured && access.enabled).length
    : null;
  trace.log({
    ok: counterparties.ok || requests.ok || recurring.ok || providerAccess !== null,
    requestCount: 4,
  });
  const base = "DashboardPayments.commandCenter.summary";
  const items = [
    {
      key: "contacts",
      href: PAYMENT_COMMAND_SUMMARY_DESTINATIONS.contacts,
      count: counterparties.ok ? counterparties.total : null,
    },
    {
      key: "openRequests",
      href: PAYMENT_COMMAND_SUMMARY_DESTINATIONS.openRequests,
      count: requests.ok ? requests.total : null,
    },
    {
      key: "schedules",
      href: PAYMENT_COMMAND_SUMMARY_DESTINATIONS.schedules,
      count: recurring.ok ? recurring.data.total : null,
    },
    {
      key: "providers",
      href: PAYMENT_COMMAND_SUMMARY_DESTINATIONS.providers,
      count: providerCount,
    },
  ];
  return (
    <section
      className="mt-8 border-t border-border-default pt-6"
      data-payments-overview-section="summary"
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-secondary">
        {items.map((item, index) => (
          <Fragment key={item.key}>
            {index > 0 ? (
              <span aria-hidden="true" className="text-tertiary">
                ·
              </span>
            ) : null}
            <Link href={item.href} className="transition-colors hover:text-primary">
              <span className="font-medium text-primary tabular-nums">{item.count ?? "—"}</span>{" "}
              {countLabel(t, `${base}.${item.key}`, item.count)}
            </Link>
          </Fragment>
        ))}
      </p>
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
    <li>
      <Link
        href={href}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-0.5 rounded-control px-2 py-3 transition-colors hover:bg-fill-subtle sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]"
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
          className="col-start-1 row-start-2 truncate text-body sm:col-start-2 sm:row-start-1"
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
  viewAll,
}: {
  rows: readonly Parameters<typeof ActivityRow>[0][] | null;
  empty: string;
  unavailable: string;
  viewAll: { href: string; label: string };
}) {
  return (
    <>
      {rows === null ? (
        <p className="py-8 text-body text-tertiary">{unavailable}</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-body text-tertiary">{empty}</p>
      ) : (
        <ul className="-mx-2 divide-y divide-border-subtle">
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
    walletsById: ReadonlyMap<string, PaymentsDashboardWallet>;
    issuedTokenSymbolsByMint: Readonly<Record<string, string>>;
  }
): Parameters<typeof ActivityRow>[0] {
  const { t, locale, walletsById, issuedTokenSymbolsByMint } = context;
  const counterparty = resolveCommandCenterCounterparty(transfer);
  const direction =
    transfer.direction === "inbound" || transfer.direction === "outbound"
      ? transfer.direction
      : undefined;
  // A ramp row leads with the fiat side the person asked for; wallet transfers with the token.
  const isRamp = transfer.type === "onramp" || transfer.type === "offramp";
  const amount =
    isRamp && transfer.fiatAmount && transfer.fiatCurrency
      ? formatSignedAmount(
          transfer.fiatAmount,
          direction ?? (transfer.type === "onramp" ? "inbound" : "outbound"),
          transfer.fiatCurrency.toUpperCase(),
          locale
        )
      : formatSignedAmount(
          transfer.amount,
          direction,
          resolveTransferTokenLabel(transfer.token, issuedTokenSymbolsByMint),
          locale
        );
  const wallet = walletName(walletsById, transfer.custodyWalletId);
  const kind = t(ACTIVITY_KIND_MESSAGE_KEYS[activityKind(transfer)]);
  return {
    href: `/dashboard/payments/transactions?search=${encodeURIComponent(transfer.id)}`,
    name: counterparty.length > 24 ? shortenAddress(counterparty) : counterparty,
    detail: wallet ? `${kind} · ${wallet}` : kind,
    status: {
      label: t(statusMessageKey(transfer.status)),
      tone: PAYMENT_STATUS_TONE[transfer.status],
    },
    amount,
    when: formatElapsedShort(transfer.createdAt, locale),
  };
}

function batchRow(
  batch: PaymentTransferBatch,
  recipients: readonly PaymentTransferRecipient[] | undefined,
  context: {
    t: Translate;
    locale: string;
    walletsById: ReadonlyMap<string, PaymentsDashboardWallet>;
    issuedTokenSymbolsByMint: Readonly<Record<string, string>>;
  }
): Parameters<typeof ActivityRow>[0] {
  const { t, locale, walletsById, issuedTokenSymbolsByMint } = context;
  const summary = summarizeBatch(batch, recipients);
  const wallet = walletName(walletsById, batch.sourceCustodyWalletId);
  const kind = t(ACTIVITY_KIND_MESSAGE_KEYS.batch);
  return {
    href: PAYMENT_COMMAND_ACTIVITY_DESTINATIONS.batches,
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
    when: formatElapsedShort(batch.createdAt, locale),
  };
}

async function Activity({ apiClientPromise }: { apiClientPromise: ApiClientPromise }) {
  const [{ request }, t, locale] = await Promise.all([
    apiClientPromise,
    getTranslations(),
    getRequestLocale(),
  ]);
  const trace = createTimedTrace("dashboard.payments.overview.activity");
  const [transfers, batches, issuedTokenSymbols, wallets] = await Promise.all([
    trace.step("fetch_recent_transfers", () =>
      fetchPaymentTransfers(request, ACTIVITY_ROW_COUNT, {
        includeObserved: false,
        types: NON_BATCH_TRANSFER_TYPES,
      })
    ),
    trace.step("fetch_recent_batches", () => fetchTransferBatches(request, ACTIVITY_ROW_COUNT)),
    fetchPaymentsIssuedTokenSymbols(request),
    fetchPaymentsWallets(request, { view: "summary" }),
  ]);
  // Recipient counts turn "partially failed" into "1 of 8 failed". Best effort: a batch whose
  // recipients fail to load falls back to its own status.
  const recipientsByBatch = await trace.step("fetch_batch_recipients", () =>
    Promise.all(
      (batches.data ?? []).map((batch) => fetchTransferBatchRecipients(request, batch.id))
    )
  );
  trace.log({
    ok: transfers.ok || batches.ok,
    requestCount: 4 + recipientsByBatch.length,
    resultCount: (transfers.data?.length ?? 0) + (batches.data?.length ?? 0),
  });
  const context = {
    t,
    locale,
    walletsById: new Map((wallets.data ?? []).map((wallet) => [wallet.id, wallet])),
    issuedTokenSymbolsByMint: Object.fromEntries(
      (issuedTokenSymbols.data ?? []).map((token) => [token.mintAddress, token.symbol])
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
              transfers.ok
                ? (transfers.data ?? []).map((transfer) => transferRow(transfer, context))
                : null
            }
            empty={t("DashboardPayments.noTransactions")}
            unavailable={unavailable}
            viewAll={{
              href: PAYMENT_COMMAND_ACTIVITY_DESTINATIONS.transfers,
              label: t("DashboardPayments.viewAllTransactions"),
            }}
          />
        }
        batches={
          <ActivityList
            rows={
              batches.ok
                ? (batches.data ?? []).map((batch, index) =>
                    batchRow(batch, recipientsByBatch[index]?.data, context)
                  )
                : null
            }
            empty={t("DashboardPayments.commandCenter.noBatches")}
            unavailable={unavailable}
            viewAll={{
              href: PAYMENT_COMMAND_ACTIVITY_DESTINATIONS.batches,
              label: t("DashboardPayments.commandCenter.viewAllBatches"),
            }}
          />
        }
      />
    </section>
  );
}

export function PaymentsCommandCenter({
  apiClientPromise,
  organizationId,
}: {
  apiClientPromise: ApiClientPromise;
  organizationId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-16 pt-4" data-payments-command-center>
      <div className="grid min-w-0 gap-10 lg:grid-cols-2 lg:gap-12">
        <div className="min-w-0">
          <Suspense fallback={<PaymentsBalanceSkeleton />}>
            <AvailableBalance apiClientPromise={apiClientPromise} />
          </Suspense>
          <Suspense fallback={<PaymentsSummarySkeleton />}>
            <PaymentsSummaryLine
              apiClientPromise={apiClientPromise}
              organizationId={organizationId}
            />
          </Suspense>
        </div>
        <MoveMoneyActions />
      </div>
      <Suspense fallback={<PaymentsActivitySkeleton />}>
        <Activity apiClientPromise={apiClientPromise} />
      </Suspense>
    </div>
  );
}
