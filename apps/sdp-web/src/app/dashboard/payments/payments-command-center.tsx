import {
  ArrowDownToLineIcon,
  ArrowRightIcon,
  CalendarClockIcon,
  QrCodeIcon,
  SendIcon,
  UsersIcon,
} from "lucide-react";
import { Suspense } from "react";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { createTimedTrace } from "@/lib/request-tracing";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchCounterparties } from "./counterparty/counterparty-page.data";
import { PAYMENT_COMMAND_ACTION_DESTINATIONS } from "./payments-command-center.constants";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsSummaryCardSkeleton,
} from "./payments-command-center-skeletons";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
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

const actionClassName =
  "group flex min-h-24 items-start gap-3 rounded-[var(--sdp-surface-radius)] border border-border-default bg-white p-4 text-left transition-colors hover:border-border-strong hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none";

const sectionClassName =
  "min-w-0 rounded-[var(--sdp-surface-radius)] border border-border-default bg-white p-5";

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-primary">{title}</h2>
      <p className="text-sm text-tertiary">{description}</p>
    </div>
  );
}

async function MoveMoneyActions() {
  const t = await getTranslations();
  const actions = [
    {
      href: PAYMENT_COMMAND_ACTION_DESTINATIONS.pay,
      label: t("DashboardPayments.pay"),
      description: t("DashboardPayments.commandCenter.payDescription"),
      icon: SendIcon,
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
      icon: QrCodeIcon,
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
      <SectionHeading
        title={t("DashboardPayments.commandCenter.moveMoney")}
        description={t("DashboardPayments.commandCenter.moveMoneyDescription")}
      />
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <DashboardNavigationLink
              key={action.href}
              href={action.href}
              className={actionClassName}
            >
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-primary">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2 text-sm font-semibold text-primary">
                  {action.label}
                  <ArrowRightIcon
                    className="size-4 shrink-0 text-tertiary transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </span>
                <span className="mt-1 block text-xs leading-5 text-tertiary">
                  {action.description}
                </span>
              </span>
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
        <SectionHeading
          title={t("DashboardPayments.commandCenter.availableBalance")}
          description={t("DashboardPayments.commandCenter.balanceUnavailable")}
        />
      </section>
    );
  }

  const balances = normalizeAggregateBalances(result.data.balances ?? []);
  const topBalances = selectTopAggregateBalanceRows(balances, {}).slice(0, 3);
  const total = resolveTotalBalance(balances);
  return (
    <section className={sectionClassName} data-payments-overview-section="balance">
      <SectionHeading
        title={t("DashboardPayments.commandCenter.availableBalance")}
        description={t("DashboardPayments.commandCenter.availableBalanceDescription", {
          count: result.data.walletCount,
          walletLabel: t(
            result.data.walletCount === 1 ? "DashboardPayments.wallet" : "DashboardPayments.wallets"
          ),
        })}
      />
      <p className="mt-4 text-[32px] font-medium tracking-[-0.04em] text-primary">
        {formatCurrencyAmount(total, locale)}
      </p>
      <div className="mt-4 divide-y divide-border-subtle border-t border-border-subtle">
        {topBalances.map((balance) => {
          const label = resolveAggregateBalanceDisplayToken(balance, {});
          const usdValue = resolveUsdBalanceValue(balance);
          return (
            <div
              key={`${balance.token}-${balance.mint}`}
              className="flex min-w-0 items-center justify-between gap-4 py-2 text-sm"
            >
              <span className="truncate font-medium text-primary" title={label}>
                {label}
              </span>
              <span className="shrink-0 text-secondary">
                {usdValue === null
                  ? formatDisplayAmount(balance.uiAmount, label, locale)
                  : formatCurrencyAmount(usdValue, locale)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
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

  return (
    <section className={sectionClassName} data-payments-overview-section="activity">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          title={t("DashboardPayments.commandCenter.activity")}
          description={t("DashboardPayments.commandCenter.activityDescription")}
        />
        <DashboardNavigationLink
          href="/dashboard/payments/transactions"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-secondary transition-colors hover:bg-fill-subtle hover:text-primary"
        >
          {t("DashboardPayments.viewAllTransactions")}
          <ArrowRightIcon className="size-4" aria-hidden="true" />
        </DashboardNavigationLink>
      </div>
      {!result.ok ? (
        <p className="mt-5 text-sm text-tertiary">
          {t("DashboardPayments.commandCenter.activityUnavailable")}
        </p>
      ) : (result.data?.length ?? 0) === 0 ? (
        <p className="mt-5 text-sm text-tertiary">{t("DashboardPayments.noTransactions")}</p>
      ) : (
        <div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
          {(result.data ?? []).map((transfer) => {
            const address = transfer.destination ?? transfer.source ?? transfer.id;
            return (
              <DashboardNavigationLink
                key={transfer.id}
                href={`/dashboard/payments/transactions?search=${encodeURIComponent(transfer.id)}`}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 text-sm hover:bg-fill-subtle sm:grid-cols-[7rem_minmax(0,1fr)_auto_auto] sm:px-2"
              >
                <span className="hidden font-medium text-primary sm:block">
                  {resolveTransferTypeLabel(transfer.type, t)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-primary">
                    {formatDisplayAmount(transfer.amount, transfer.token, locale)}
                  </span>
                  <span className="block truncate text-xs text-tertiary sm:hidden">
                    {resolveTransferTypeLabel(transfer.type, t)} · {shortenAddress(address)}
                  </span>
                </span>
                <span className="hidden max-w-40 truncate text-secondary sm:block" title={address}>
                  {shortenAddress(address)}
                </span>
                <span className="shrink-0 text-xs text-tertiary">
                  {formatTimestamp(transfer.createdAt, t, locale)}
                </span>
              </DashboardNavigationLink>
            );
          })}
        </div>
      )}
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
  const unavailable = !recurring.ok && !requests.ok;
  return (
    <section className={sectionClassName} data-payments-overview-section="upcoming">
      <SectionHeading
        title={t("DashboardPayments.commandCenter.upcomingOpen")}
        description={
          unavailable
            ? t("DashboardPayments.commandCenter.upcomingUnavailable")
            : t("DashboardPayments.commandCenter.upcomingOpenDescription")
        }
      />
      <div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
        <DashboardNavigationLink
          href="/dashboard/payments/recurring"
          className="flex items-center justify-between gap-3 py-3 text-sm"
        >
          <span className="text-secondary">
            {t("DashboardPayments.commandCenter.activeSchedules")}
          </span>
          <span className="font-semibold text-primary">{recurring.ok ? recurring.total : "—"}</span>
        </DashboardNavigationLink>
        <DashboardNavigationLink
          href="/dashboard/payments/requests"
          className="flex items-center justify-between gap-3 py-3 text-sm"
        >
          <span className="text-secondary">
            {t("DashboardPayments.commandCenter.openRequests")}
          </span>
          <span className="font-semibold text-primary">{requests.ok ? requests.total : "—"}</span>
        </DashboardNavigationLink>
      </div>
    </section>
  );
}

async function PaymentNetwork({ apiClientPromise }: { apiClientPromise: ApiClientPromise }) {
  const [{ request }, t] = await Promise.all([apiClientPromise, getTranslations()]);
  const trace = createTimedTrace("dashboard.payments.overview.network");
  const result = await trace.step("fetch_counterparty_summary", () =>
    fetchCounterparties(request, { page: 1, pageSize: 1 })
  );
  trace.log({
    ok: result.ok,
    requestCount: 1,
    responseBytes: new TextEncoder().encode(JSON.stringify(result)).byteLength,
  });
  return (
    <section className={sectionClassName} data-payments-overview-section="network">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-primary">
          <UsersIcon className="size-4" aria-hidden="true" />
        </span>
        <SectionHeading
          title={t("DashboardPayments.commandCenter.paymentNetwork")}
          description={
            result.ok
              ? t("DashboardPayments.commandCenter.counterpartiesReady", { count: result.total })
              : t("DashboardPayments.commandCenter.networkUnavailable")
          }
        />
      </div>
      <DashboardNavigationLink
        href="/dashboard/payments/counterparty"
        className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg border border-border-default px-3 text-sm font-medium text-primary transition-colors hover:bg-fill-subtle"
      >
        {t("DashboardPayments.commandCenter.manageCounterparties")}
        <ArrowRightIcon className="size-4" aria-hidden="true" />
      </DashboardNavigationLink>
    </section>
  );
}

export function PaymentsCommandCenter({
  apiClientPromise,
}: {
  apiClientPromise: ApiClientPromise;
}) {
  return (
    <DashboardWorkspaceOverviewPanel
      className="grid content-start gap-4"
      data-payments-command-center
    >
      <MoveMoneyActions />
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.5fr)]">
        <Suspense fallback={<PaymentsBalanceSkeleton />}>
          <AvailableBalance apiClientPromise={apiClientPromise} />
        </Suspense>
        <Suspense fallback={<PaymentsActivitySkeleton />}>
          <Activity apiClientPromise={apiClientPromise} />
        </Suspense>
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Suspense fallback={<PaymentsSummaryCardSkeleton name="upcoming" />}>
          <UpcomingOpen apiClientPromise={apiClientPromise} />
        </Suspense>
        <Suspense fallback={<PaymentsSummaryCardSkeleton name="network" />}>
          <PaymentNetwork apiClientPromise={apiClientPromise} />
        </Suspense>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
