import type { PaymentTransferSummary } from "@sdp/types";
import {
  ArrowDownToLineIcon,
  ArrowRightIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  LinkIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import { Suspense } from "react";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createTimedTrace } from "@/lib/request-tracing";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchCounterparties } from "./counterparty/counterparty-page.data";
import { PAYMENT_COMMAND_ACTION_DESTINATIONS } from "./payments-command-center.constants";
import { resolveCommandCenterCounterparty } from "./payments-command-center.utils";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsNetworkSkeleton,
  PaymentsUpcomingSkeleton,
} from "./payments-command-center-skeletons";
import {
  formatCurrencyAmount,
  formatDirection,
  formatTimestamp,
  normalizeAggregateBalances,
  resolveAggregateBalanceDisplayToken,
  resolveTotalBalance,
  resolveTransferTypeLabel,
  resolveUsdBalanceValue,
  selectTopAggregateBalanceRows,
  shortenAddress,
} from "./payments-overview.utils";
import { fetchPaymentsAggregate, fetchPaymentTransfers } from "./payments-page.data";
import { fetchRecurringPayments } from "./recurring/recurring-payments.data";
import { fetchPaymentRequests } from "./requests/payment-requests-page.data";

type ApiClientPromise = Promise<{ request: SdpApiClient["request"] }>;

const sectionClassName = "min-w-0 rounded-lg border border-border-default bg-surface-raised p-4";
const activityColumns = "grid-cols-[6.5rem_8rem_minmax(8rem,1fr)_8rem_7.5rem_1rem]";

function SectionHeading({ title }: { title: string }) {
  return <h2 className="text-base font-semibold tracking-[-0.01em] text-primary">{title}</h2>;
}

async function MoveMoneyActions() {
  const t = await getTranslations();
  const actions = [
    {
      href: PAYMENT_COMMAND_ACTION_DESTINATIONS.pay,
      label: t("DashboardPayments.pay"),
      description: t("DashboardPayments.commandCenter.payDescription"),
      icon: ArrowRightIcon,
    },
    {
      href: PAYMENT_COMMAND_ACTION_DESTINATIONS.deposit,
      label: t("DashboardPayments.deposit"),
      description: t("DashboardPayments.commandCenter.depositDescription"),
      icon: ArrowDownToLineIcon,
    },
    {
      href: PAYMENT_COMMAND_ACTION_DESTINATIONS.request,
      label: t("DashboardPayments.commandCenter.requestPayment"),
      description: t("DashboardPayments.commandCenter.requestPaymentDescription"),
      icon: LinkIcon,
    },
    {
      href: PAYMENT_COMMAND_ACTION_DESTINATIONS.schedule,
      label: t("DashboardPayments.commandCenter.schedule"),
      description: t("DashboardPayments.commandCenter.scheduleDescription"),
      icon: CalendarClockIcon,
    },
  ];

  return (
    <section className={sectionClassName} data-payments-overview-section="actions">
      <SectionHeading title={t("DashboardPayments.commandCenter.moveMoney")} />
      <div className="mt-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <DashboardNavigationLink
              key={action.href}
              href={action.href}
              className="group flex min-h-36 min-w-0 flex-col items-center justify-center rounded-md border border-border-default px-3 py-4 text-center transition-colors hover:border-border-strong hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none xl:min-h-44"
            >
              <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-primary transition-colors group-hover:bg-fill-strong">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span className="mt-3 text-base font-semibold text-primary">{action.label}</span>
              <span className="mt-1 text-sm leading-5 text-secondary">{action.description}</span>
            </DashboardNavigationLink>
          );
        })}
      </div>
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
  const result = await trace.step("fetch_aggregate", () => fetchPaymentsAggregate(request));
  trace.log({
    ok: result.ok,
    requestCount: 1,
    responseBytes: new TextEncoder().encode(JSON.stringify(result.data ?? null)).byteLength,
  });
  if (!result.ok || !result.data) {
    return (
      <section className={sectionClassName} data-payments-overview-section="balance">
        <SectionHeading title={t("DashboardPayments.commandCenter.availableBalance")} />
        <p className="mt-3 text-sm text-tertiary">
          {t("DashboardPayments.commandCenter.balanceUnavailable")}
        </p>
      </section>
    );
  }

  const balances = normalizeAggregateBalances(result.data.balances ?? []);
  const topBalances = selectTopAggregateBalanceRows(balances, {}).slice(0, 3);
  return (
    <section className={sectionClassName} data-payments-overview-section="balance">
      <SectionHeading title={t("DashboardPayments.commandCenter.availableBalance")} />
      <p className="mt-3 text-[30px] font-medium tracking-[-0.04em] text-primary">
        {formatCurrencyAmount(resolveTotalBalance(balances), locale)}
      </p>
      <p className="mt-1 text-sm text-tertiary">
        {t("DashboardPayments.commandCenter.availableBalanceDescription", {
          count: result.data.walletCount,
          walletLabel: t(
            result.data.walletCount === 1 ? "DashboardPayments.wallet" : "DashboardPayments.wallets"
          ),
        })}
      </p>
      <div className="mt-4 divide-y divide-border-subtle border-t border-border-default">
        {topBalances.map((balance) => {
          const label = resolveAggregateBalanceDisplayToken(balance, {});
          const usdValue = resolveUsdBalanceValue(balance);
          return (
            <div
              key={`${balance.token}-${balance.mint}`}
              className="flex min-w-0 items-center justify-between gap-3 py-2.5 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2 font-medium text-primary">
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-[11px] font-semibold text-secondary">
                  {label.slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate" title={label}>
                  {label.length > 12 ? shortenAddress(label) : label}
                </span>
              </span>
              <span className="shrink-0 text-secondary">
                {usdValue === null
                  ? `${balance.uiAmount} ${label.length > 10 ? shortenAddress(label) : label}`
                  : formatCurrencyAmount(usdValue, locale)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function statusVariant(status: string): BadgeVariant {
  if (["completed", "confirmed", "finalized"].includes(status)) return "success";
  if (["pending", "processing", "awaiting_payment", "settling"].includes(status)) {
    return "warning";
  }
  if (status === "failed") return "danger";
  return "default";
}

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function compactAmount(transfer: PaymentTransferSummary): string {
  if (!transfer.amount) return "—";
  const sign =
    transfer.direction === "inbound" ? "+" : transfer.direction === "outbound" ? "−" : "";
  const amount = transfer.amount.replace(/^-/, "");
  const asset = transfer.token
    ? transfer.token.length > 10
      ? shortenAddress(transfer.token)
      : transfer.token
    : "";
  return `${sign}${amount}${asset ? ` ${asset}` : ""}`;
}

function compactType(transfer: PaymentTransferSummary): string {
  if (transfer.type === "transfer_confidential") return "Confidential";
  if (transfer.type === "transfer_batch") return "Batch";
  if (transfer.type === "onramp") return "Deposit";
  if (transfer.type === "offramp") return "Payout";
  return "Transfer";
}

async function Activity({ apiClientPromise }: { apiClientPromise: ApiClientPromise }) {
  const [{ request }, t, locale] = await Promise.all([
    apiClientPromise,
    getTranslations(),
    getRequestLocale(),
  ]);
  const trace = createTimedTrace("dashboard.payments.overview.activity");
  const result = await trace.step("fetch_recent_transfers", () =>
    fetchPaymentTransfers(request, 5, { includeObserved: false })
  );
  trace.log({
    ok: result.ok,
    requestCount: 1,
    responseBytes: new TextEncoder().encode(JSON.stringify(result.data ?? [])).byteLength,
    resultCount: result.data?.length ?? 0,
  });
  const transfers = result.data ?? [];

  return (
    // self-start keeps this card at its content height instead of stretching to match the
    // taller Upcoming/Network column, which otherwise leaves dead space inside the card.
    <section className={`${sectionClassName} self-start`} data-payments-overview-section="activity">
      <SectionHeading title={t("DashboardPayments.commandCenter.activity")} />
      <div className="mt-3 flex items-end gap-5 border-b border-border-default text-sm">
        <DashboardNavigationLink
          href="/dashboard/payments/transactions?type=transfer"
          className="border-b-2 border-primary px-0.5 pb-2 font-medium text-primary"
        >
          {t("DashboardPayments.commandCenter.transfers")}
        </DashboardNavigationLink>
        <DashboardNavigationLink
          href="/dashboard/payments/transactions?type=transfer_batch"
          className="px-0.5 pb-2 text-secondary hover:text-primary"
        >
          {t("DashboardPayments.commandCenter.batches")}
        </DashboardNavigationLink>
      </div>
      {!result.ok ? (
        <p className="py-8 text-sm text-tertiary">
          {t("DashboardPayments.commandCenter.activityUnavailable")}
        </p>
      ) : transfers.length === 0 ? (
        <p className="py-8 text-sm text-tertiary">{t("DashboardPayments.noTransactions")}</p>
      ) : (
        <>
          <div className="mt-2 hidden overflow-hidden rounded-md border border-border-default lg:block">
            <div
              className={`grid ${activityColumns} items-center gap-2 bg-fill-subtle px-3 py-2 text-xs font-medium text-secondary`}
            >
              <span>{t("DashboardPayments.status")}</span>
              <span>{t("DashboardPayments.commandCenter.typeDirection")}</span>
              <span>{t("DashboardPayments.counterpartyLabel")}</span>
              <span>{t("DashboardPayments.commandCenter.amount")}</span>
              <span>{t("DashboardPayments.createdLabel")}</span>
              <span aria-hidden="true" />
            </div>
            <div className="divide-y divide-border-subtle">
              {transfers.map((transfer) => {
                const counterparty = resolveCommandCenterCounterparty(transfer);
                return (
                  <DashboardNavigationLink
                    key={transfer.id}
                    href={`/dashboard/payments/transactions?search=${encodeURIComponent(transfer.id)}`}
                    className={`grid min-h-12 ${activityColumns} items-center gap-2 px-3 text-sm transition-colors hover:bg-fill-subtle`}
                  >
                    <span>
                      <Badge variant={statusVariant(transfer.status)}>
                        {formatStatus(transfer.status)}
                      </Badge>
                    </span>
                    <span
                      className="min-w-0 truncate text-primary"
                      title={`${formatDirection(transfer.direction, t)} · ${resolveTransferTypeLabel(transfer.type, t)}`}
                    >
                      {formatDirection(transfer.direction, t)} · {compactType(transfer)}
                    </span>
                    <span className="truncate text-secondary" title={counterparty}>
                      {counterparty.length > 24 ? shortenAddress(counterparty) : counterparty}
                    </span>
                    <span
                      className="truncate font-medium text-primary"
                      title={compactAmount(transfer)}
                    >
                      {compactAmount(transfer)}
                    </span>
                    <span className="truncate text-xs text-secondary">
                      {formatTimestamp(transfer.createdAt, t, locale)}
                    </span>
                    <ChevronRightIcon className="size-4 text-tertiary" aria-hidden="true" />
                  </DashboardNavigationLink>
                );
              })}
            </div>
          </div>
          <div className="mt-2 divide-y divide-border-subtle border-y border-border-default lg:hidden">
            {transfers.map((transfer) => {
              const counterparty = resolveCommandCenterCounterparty(transfer);
              return (
                <DashboardNavigationLink
                  key={transfer.id}
                  href={`/dashboard/payments/transactions?search=${encodeURIComponent(transfer.id)}`}
                  className="block space-y-2 py-3 text-sm"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-primary">
                      {resolveTransferTypeLabel(transfer.type, t)} ·{" "}
                      {formatDirection(transfer.direction, t)}
                    </span>
                    <Badge variant={statusVariant(transfer.status)}>
                      {formatStatus(transfer.status)}
                    </Badge>
                  </span>
                  <span className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate text-secondary">{counterparty}</span>
                    <span className="shrink-0 font-medium text-primary">
                      {compactAmount(transfer)}
                    </span>
                  </span>
                </DashboardNavigationLink>
              );
            })}
          </div>
        </>
      )}
      <DashboardNavigationLink
        href="/dashboard/payments/transactions"
        className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-link hover:underline"
      >
        {t("DashboardPayments.viewAllTransactions")}
        <ChevronRightIcon className="size-4" aria-hidden="true" />
      </DashboardNavigationLink>
    </section>
  );
}

async function UpcomingOpen({ apiClientPromise }: { apiClientPromise: ApiClientPromise }) {
  const [{ request }, t] = await Promise.all([apiClientPromise, getTranslations()]);
  const trace = createTimedTrace("dashboard.payments.overview.upcoming");
  const [recurring, requests] = await trace.step("fetch_open_work", () =>
    Promise.all([
      fetchRecurringPayments(request, t, { page: 1, pageSize: 1, status: "active" }),
      fetchPaymentRequests(request, { pageSize: 1, status: "awaiting_payment" }),
    ])
  );
  trace.log({
    ok: recurring.ok || requests.ok,
    requestCount: 2,
    responseBytes: new TextEncoder().encode(JSON.stringify({ recurring, requests })).byteLength,
  });
  const rows = [
    {
      href: "/dashboard/payments/recurring",
      icon: CalendarClockIcon,
      count: recurring.ok ? recurring.total : null,
      label: t("DashboardPayments.commandCenter.activeSchedules"),
    },
    {
      href: "/dashboard/payments/requests",
      icon: LinkIcon,
      count: requests.ok ? requests.total : null,
      label: t("DashboardPayments.commandCenter.openRequests"),
    },
  ];
  return (
    <section className={sectionClassName} data-payments-overview-section="upcoming">
      <SectionHeading title={t("DashboardPayments.commandCenter.upcomingOpen")} />
      <div className="mt-3 divide-y divide-border-subtle border-y border-border-default">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <DashboardNavigationLink
              key={row.href}
              href={row.href}
              className="flex min-h-14 items-center gap-3 py-2 text-sm hover:bg-fill-subtle"
            >
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-secondary">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 text-secondary">
                <strong className="font-semibold text-primary">{row.count ?? "—"}</strong>{" "}
                {row.label}
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
            </DashboardNavigationLink>
          );
        })}
      </div>
    </section>
  );
}

async function PaymentNetwork({
  apiClientPromise,
  organizationId,
}: {
  apiClientPromise: ApiClientPromise;
  organizationId: string;
}) {
  const [{ request }, t] = await Promise.all([apiClientPromise, getTranslations()]);
  const trace = createTimedTrace("dashboard.payments.overview.network");
  const [result, providerAccess] = await trace.step("fetch_network_summary", () =>
    Promise.all([
      fetchCounterparties(request, { page: 1, pageSize: 1 }),
      fetchProviderAvailability(request, organizationId).catch(() => null),
    ])
  );
  const enabledProviderCount = providerAccess
    ? Object.values(providerAccess.rampProviderAccess).filter(
        (provider) => provider.entitled && provider.configured && provider.enabled
      ).length
    : null;
  trace.log({
    ok: result.ok || providerAccess !== null,
    requestCount: 2,
    responseBytes: new TextEncoder().encode(JSON.stringify({ result, providerAccess })).byteLength,
  });
  return (
    <section className={`${sectionClassName} pb-0`} data-payments-overview-section="network">
      <SectionHeading title={t("DashboardPayments.commandCenter.paymentNetwork")} />
      <div className="mt-4 grid grid-cols-2 divide-x divide-border-default">
        <div className="flex items-center gap-3 pr-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-secondary">
            <UsersIcon className="size-5" aria-hidden="true" />
          </span>
          <span>
            <strong className="block text-xl font-semibold text-primary">
              {result.ok ? result.total : "—"}
            </strong>
            <span className="text-xs text-tertiary">
              {t("DashboardPayments.commandCenter.counterparties")}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-3 pl-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-secondary">
            <ShieldCheckIcon className="size-5" aria-hidden="true" />
          </span>
          <span>
            <strong className="block text-xl font-semibold text-primary">
              {enabledProviderCount ?? "—"}
            </strong>
            <span className="text-xs text-tertiary">
              {t("DashboardPayments.commandCenter.providersEnabled")}
            </span>
          </span>
        </div>
      </div>
      <DashboardNavigationLink
        href="/dashboard/payments/counterparty"
        className="-mx-4 mt-4 flex h-11 items-center gap-1 border-t border-border-default px-4 text-sm font-medium text-link hover:bg-fill-subtle"
      >
        {t("DashboardPayments.commandCenter.manageCounterparties")}
        <ChevronRightIcon className="size-4" aria-hidden="true" />
      </DashboardNavigationLink>
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
    <DashboardWorkspaceOverviewPanel
      className="grid content-start gap-4 xl:grid-cols-[minmax(0,1.63fr)_minmax(20rem,1fr)]"
      data-payments-command-center
    >
      <MoveMoneyActions />
      <Suspense fallback={<PaymentsBalanceSkeleton />}>
        <AvailableBalance apiClientPromise={apiClientPromise} />
      </Suspense>
      <Suspense fallback={<PaymentsActivitySkeleton />}>
        <Activity apiClientPromise={apiClientPromise} />
      </Suspense>
      <div className="grid min-w-0 content-start gap-4">
        <Suspense fallback={<PaymentsUpcomingSkeleton />}>
          <UpcomingOpen apiClientPromise={apiClientPromise} />
        </Suspense>
        <Suspense fallback={<PaymentsNetworkSkeleton />}>
          <PaymentNetwork apiClientPromise={apiClientPromise} organizationId={organizationId} />
        </Suspense>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
