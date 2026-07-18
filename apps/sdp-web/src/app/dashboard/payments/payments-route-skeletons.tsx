import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

const TABLE_ROW_IDS = [
  "payments-loading-row-1",
  "payments-loading-row-2",
  "payments-loading-row-3",
  "payments-loading-row-4",
  "payments-loading-row-5",
];
const DETAIL_ROW_IDS = [
  "payments-loading-detail-1",
  "payments-loading-detail-2",
  "payments-loading-detail-3",
  "payments-loading-detail-4",
  "payments-loading-detail-5",
  "payments-loading-detail-6",
  "payments-loading-detail-7",
  "payments-loading-detail-8",
];
const WIZARD_OPTION_IDS = [
  "payments-loading-option-1",
  "payments-loading-option-2",
  "payments-loading-option-3",
];

function WorkspaceCardHeaderSkeleton({
  withAction = true,
  stackActionOnMobile = false,
}: {
  withAction?: boolean;
  stackActionOnMobile?: boolean;
}) {
  return (
    <CardHeader className={stackActionOnMobile ? "flex min-w-0 flex-col gap-4 sm:grid" : undefined}>
      <div className="min-w-0 space-y-2">
        <SkeletonBlock className="h-6 w-52 max-w-full" />
        <SkeletonBlock className="h-4 w-80 max-w-full" />
      </div>
      {withAction ? (
        <CardAction>
          <SkeletonBlock className="h-10 w-32 max-w-full rounded-[10px]" />
        </CardAction>
      ) : null}
    </CardHeader>
  );
}

function ResponsiveTableSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className="min-w-0 max-w-full" data-loading-table>
      <div className="hidden overflow-hidden rounded-xl ring-1 ring-border-default md:block">
        <div className="grid grid-cols-[1.1fr_1.4fr_1.2fr_1fr] gap-6 bg-fill-subtle px-6 py-3">
          <SkeletonBlock className="h-4 w-20" />
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-4 w-20" />
          <SkeletonBlock className="h-4 w-24" />
        </div>
        <div className="divide-y divide-border-default bg-white">
          {TABLE_ROW_IDS.map((id) => (
            <div
              key={id}
              className="grid min-h-14 grid-cols-[1.1fr_1.4fr_1.2fr_1fr] items-center gap-6 px-6"
            >
              <SkeletonBlock className="h-5 w-20 max-w-full rounded-full" />
              <SkeletonBlock className="h-4 w-28 max-w-full" />
              <SkeletonBlock className="h-4 w-32 max-w-full" />
              <SkeletonBlock className="h-4 w-24 max-w-full" />
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2 md:hidden" data-loading-mobile-rows>
        {TABLE_ROW_IDS.slice(0, compact ? 4 : 5).map((id) => (
          <div key={id} className="space-y-3 rounded-xl bg-fill-subtle px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <SkeletonBlock className="h-5 w-20 rounded-full" />
              <SkeletonBlock className="h-4 w-20" />
            </div>
            <SkeletonBlock className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkspaceTablePageSkeleton({
  layout,
  compact,
}: {
  layout: "payment-requests" | "counterparty-directory";
  compact?: boolean;
}) {
  return (
    <DashboardWorkspaceOverviewPanel
      className="flex min-h-0 flex-col overflow-hidden"
      data-loading-layout={layout}
      aria-busy="true"
    >
      <Card className="flex min-h-0 flex-1 flex-col">
        <WorkspaceCardHeaderSkeleton />
        <CardContent className="min-h-0 flex-1">
          <ResponsiveTableSkeleton compact={compact} />
        </CardContent>
      </Card>
    </DashboardWorkspaceOverviewPanel>
  );
}

function WizardProgressSkeleton({ steps }: { steps: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: steps }, (_, index) => `wizard-step-${steps}-${index}`).map(
          (id, index) => (
            <SkeletonBlock
              key={id}
              className={index === 0 ? "h-1.5 w-4 rounded-full" : "size-1.5 rounded-full"}
            />
          )
        )}
      </div>
      <SkeletonBlock className="h-3 w-16" />
    </div>
  );
}

function WizardPageSkeleton({
  layout,
  steps = 2,
}: {
  layout: "payments-pay" | "payments-deposit" | "recurring-payment-create";
  steps?: number;
}) {
  return (
    <div
      className="mx-auto flex h-[80vh] w-full max-w-5xl flex-col py-6"
      data-loading-layout={layout}
      data-loading-wizard
      aria-busy="true"
    >
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-hidden px-1.5">
        <div className="space-y-4">
          <WizardProgressSkeleton steps={steps} />
          <SkeletonBlock className="h-9 w-80 max-w-[88%]" />
        </div>
        <div className="space-y-3">
          {WIZARD_OPTION_IDS.map((id) => (
            <div
              key={id}
              className="flex min-h-16 items-center gap-4 rounded-2xl bg-white px-4 py-3 ring-1 ring-border-default"
            >
              <SkeletonBlock className="size-10 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <SkeletonBlock className="h-4 w-44 max-w-full" />
                <SkeletonBlock className="h-3 w-64 max-w-full" />
              </div>
              <SkeletonBlock className="size-5 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pt-4 pb-1 sm:flex-row sm:justify-between">
        <SkeletonBlock className="h-14 w-full rounded-full sm:w-28" />
        <SkeletonBlock className="h-14 w-full rounded-full sm:w-28" />
      </div>
    </div>
  );
}

function DetailRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="divide-y divide-border-default" data-loading-detail-rows>
      {DETAIL_ROW_IDS.slice(0, count).map((id, index) => (
        <div key={id} className="flex min-h-12 items-center justify-between gap-6 py-3">
          <SkeletonBlock className="h-4 w-24 shrink-0" />
          <SkeletonBlock className={index % 3 === 0 ? "h-5 w-24 rounded-full" : "h-4 w-40"} />
        </div>
      ))}
    </div>
  );
}

export function PaymentRequestsPageSkeleton() {
  return <WorkspaceTablePageSkeleton layout="payment-requests" />;
}

export function CounterpartyDirectorySkeleton() {
  return <WorkspaceTablePageSkeleton layout="counterparty-directory" compact />;
}

export function PaymentsPayPageSkeleton() {
  return <WizardPageSkeleton layout="payments-pay" />;
}

export function PaymentsDepositPageSkeleton() {
  return <WizardPageSkeleton layout="payments-deposit" />;
}

export function RecurringPaymentCreateSkeleton() {
  return <WizardPageSkeleton layout="recurring-payment-create" steps={4} />;
}

export function CounterpartyCreateSkeleton() {
  return (
    <div
      className="mx-auto flex h-[80vh] w-full max-w-xl flex-col py-4"
      data-loading-layout="counterparty-create"
      data-loading-wizard
      aria-busy="true"
    >
      <WizardProgressSkeleton steps={4} />
      <div className="mt-6 min-h-0 flex-1 space-y-6 overflow-hidden px-1 py-1">
        <div className="space-y-2">
          <SkeletonBlock className="h-8 w-52 max-w-full" />
          <SkeletonBlock className="h-4 w-full max-w-md" />
        </div>
        <div className="space-y-5">
          <SkeletonBlock className="h-14 w-full rounded-xl" />
          <SkeletonBlock className="h-14 w-full rounded-xl" />
          <SkeletonBlock className="h-24 w-full rounded-xl" />
        </div>
      </div>
      <div className="mt-6 flex justify-between gap-3">
        <SkeletonBlock className="h-11 w-28 rounded-[10px]" />
        <SkeletonBlock className="h-11 w-28 rounded-[10px]" />
      </div>
    </div>
  );
}

export function CounterpartyDetailSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      className="space-y-6"
      data-loading-layout="counterparty-detail"
      aria-busy="true"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <SkeletonBlock className="h-9 w-64 max-w-full" />
          <SkeletonBlock className="h-4 w-40" />
        </div>
        <SkeletonBlock className="h-9 w-28 rounded-[10px]" />
      </div>
      <div className="flex gap-6 border-b border-border-default pb-3">
        <SkeletonBlock className="h-5 w-16" />
        <SkeletonBlock className="h-5 w-24" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <SkeletonBlock className="h-8 w-28" />
          <div className="rounded-2xl bg-white px-5 ring-1 ring-border-default">
            <DetailRowsSkeleton count={6} />
          </div>
        </section>
        <section className="space-y-3">
          <SkeletonBlock className="h-8 w-52" />
          <div className="space-y-4 rounded-2xl bg-white p-5 ring-1 ring-border-default">
            {DETAIL_ROW_IDS.slice(0, 5).map((id) => (
              <div key={id} className="flex items-center gap-3">
                <SkeletonBlock className="size-8 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock className="h-4 w-40 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <SkeletonBlock className="h-8 w-48" />
          <SkeletonBlock className="h-9 w-40 rounded-[10px]" />
        </div>
        <SkeletonBlock className="h-24 w-full rounded-2xl" />
      </section>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function RecurringPaymentsPageSkeleton() {
  return (
    <div
      className="h-full min-h-0 w-full px-3 pt-6 pb-5 md:px-6 md:pb-6"
      data-loading-layout="recurring-payments"
      aria-busy="true"
    >
      <Card className="flex h-full min-h-0 min-w-0 flex-col">
        <WorkspaceCardHeaderSkeleton stackActionOnMobile />
        <CardContent className="min-h-0 min-w-0 flex-1">
          <ResponsiveTableSkeleton />
        </CardContent>
      </Card>
    </div>
  );
}

export function RecurringPaymentDetailSkeleton() {
  return (
    <div
      className="h-full min-h-0 w-full overflow-hidden px-3 pt-6 pb-5 md:px-6 md:pb-6"
      data-loading-layout="recurring-payment-detail"
      aria-busy="true"
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <SkeletonBlock className="h-9 w-48" />
            <SkeletonBlock className="h-4 w-80 max-w-full" />
          </div>
          <SkeletonBlock className="h-9 w-28 rounded-[10px]" />
        </div>
        <SkeletonBlock className="h-20 w-full rounded-xl" />
        <div className="rounded-xl px-4 ring-1 ring-border-default">
          <DetailRowsSkeleton />
        </div>
        <Card className="gap-4">
          <WorkspaceCardHeaderSkeleton withAction={false} />
          <CardContent>
            <div className="space-y-3">
              {TABLE_ROW_IDS.slice(0, 3).map((id) => (
                <SkeletonBlock key={id} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
