import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

type TableSkeletonVariant = "payment-requests" | "counterparty-directory" | "recurring-payments";

interface TableSkeletonColumn {
  id: string;
  headerClassName: string;
  cellClassName?: string;
  headerSkeletonClassName?: string;
  cellSkeletonClassName: string;
}

interface TableSkeletonConfig {
  tableClassName: string;
  containerClassName: string;
  columns: readonly TableSkeletonColumn[];
}

const TABLE_SKELETON_CONFIGS: Record<TableSkeletonVariant, TableSkeletonConfig> = {
  "payment-requests": {
    tableClassName: "[&_table]:table-fixed",
    containerClassName: "min-h-0 flex-1 overflow-y-auto",
    columns: [
      {
        id: "status",
        headerClassName: "w-[16%]",
        headerSkeletonClassName: "h-4 w-16",
        cellSkeletonClassName: "h-5 w-20 max-w-full rounded-full",
      },
      {
        id: "amount",
        headerClassName: "w-[20%]",
        headerSkeletonClassName: "h-4 w-20",
        cellSkeletonClassName: "h-4 w-24 max-w-full",
      },
      {
        id: "from",
        headerClassName: "w-[22%]",
        headerSkeletonClassName: "h-4 w-16",
        cellSkeletonClassName: "h-4 w-28 max-w-full",
      },
      {
        id: "to",
        headerClassName: "w-[22%]",
        headerSkeletonClassName: "h-4 w-12",
        cellSkeletonClassName: "h-4 w-28 max-w-full",
      },
      {
        id: "created",
        headerClassName: "w-[20%]",
        headerSkeletonClassName: "h-4 w-20",
        cellSkeletonClassName: "h-4 w-24 max-w-full",
      },
    ],
  },
  "counterparty-directory": {
    tableClassName: "[&_table]:table-fixed",
    containerClassName: "min-h-0 flex-1 overflow-y-auto",
    columns: [
      {
        id: "display-name",
        headerClassName: "w-[30%]",
        headerSkeletonClassName: "h-4 w-24",
        cellSkeletonClassName: "h-4 w-32 max-w-full",
      },
      {
        id: "type",
        headerClassName: "w-[12%]",
        headerSkeletonClassName: "h-4 w-12",
        cellSkeletonClassName: "h-4 w-16 max-w-full",
      },
      {
        id: "email",
        headerClassName: "w-[24%]",
        headerSkeletonClassName: "h-4 w-16",
        cellSkeletonClassName: "h-4 w-28 max-w-full",
      },
      {
        id: "external-id",
        headerClassName: "w-[16%]",
        headerSkeletonClassName: "h-4 w-20",
        cellSkeletonClassName: "h-4 w-24 max-w-full",
      },
      {
        id: "created",
        headerClassName: "w-[18%]",
        headerSkeletonClassName: "h-4 w-20",
        cellSkeletonClassName: "h-4 w-20 max-w-full",
      },
      {
        id: "actions",
        headerClassName: "w-[56px]",
        cellClassName: "text-right",
        cellSkeletonClassName: "ml-auto size-8 rounded-lg",
      },
    ],
  },
  "recurring-payments": {
    tableClassName: "w-full [&_table]:table-fixed",
    containerClassName: "min-h-0 flex-1 overflow-hidden",
    columns: [
      {
        id: "status",
        headerClassName: "w-[34%] md:w-[26%] lg:w-[21%] xl:w-[18%]",
        headerSkeletonClassName: "h-4 w-16",
        cellSkeletonClassName: "h-5 w-20 max-w-full rounded-full",
      },
      {
        id: "amount",
        headerClassName: "w-[26%] md:w-[22%] lg:w-[20%] xl:w-[18%]",
        headerSkeletonClassName: "h-4 w-20",
        cellSkeletonClassName: "h-4 w-24 max-w-full",
      },
      {
        id: "counterparty",
        headerClassName: "w-[40%] md:w-[34%] lg:w-[31%] xl:w-[24%]",
        headerSkeletonClassName: "h-4 w-24",
        cellSkeletonClassName: "h-4 w-28 max-w-full",
      },
      {
        id: "funding-wallet",
        headerClassName: "hidden lg:table-cell lg:w-[28%] xl:w-[22%]",
        cellClassName: "hidden lg:table-cell",
        headerSkeletonClassName: "h-4 w-24",
        cellSkeletonClassName: "h-4 w-28 max-w-full",
      },
      {
        id: "interval",
        headerClassName: "hidden xl:table-cell xl:w-[18%]",
        cellClassName: "hidden xl:table-cell",
        headerSkeletonClassName: "h-4 w-16",
        cellSkeletonClassName: "h-4 w-20 max-w-full",
      },
      {
        id: "next-payment",
        headerClassName: "hidden md:table-cell md:w-[18%] xl:hidden 2xl:table-cell 2xl:w-[18%]",
        cellClassName: "hidden md:table-cell xl:hidden 2xl:table-cell",
        headerSkeletonClassName: "h-4 w-24",
        cellSkeletonClassName: "h-4 w-24 max-w-full",
      },
    ],
  },
};

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

function RouteTableSkeleton({ variant }: { variant: TableSkeletonVariant }) {
  const config = TABLE_SKELETON_CONFIGS[variant];

  return (
    <div
      className={config.containerClassName}
      data-loading-table
      data-loading-table-variant={variant}
    >
      <Table className={config.tableClassName}>
        <TableHeader>
          <TableRow>
            {config.columns.map((column) => (
              <TableHead
                key={column.id}
                className={column.headerClassName}
                data-loading-column={column.id}
              >
                {column.headerSkeletonClassName ? (
                  <SkeletonBlock className={column.headerSkeletonClassName} />
                ) : null}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {TABLE_ROW_IDS.map((rowId) => (
            <TableRow key={rowId} data-loading-table-row>
              {config.columns.map((column) => (
                <TableCell key={column.id} className={column.cellClassName}>
                  <SkeletonBlock className={column.cellSkeletonClassName} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function WorkspaceTablePageSkeleton({
  layout,
}: {
  layout: "payment-requests" | "counterparty-directory";
}) {
  return (
    <DashboardWorkspaceOverviewPanel
      className="flex min-h-0 flex-col overflow-hidden"
      data-loading-layout={layout}
      aria-busy="true"
    >
      <Card className="flex min-h-0 flex-1 flex-col bg-surface-raised">
        <WorkspaceCardHeaderSkeleton />
        <CardContent className="flex min-h-0 flex-1 flex-col">
          <RouteTableSkeleton variant={layout} />
        </CardContent>
      </Card>
    </DashboardWorkspaceOverviewPanel>
  );
}

function CounterpartyPickerSkeleton() {
  return (
    <div className="space-y-3" data-loading-counterparty-picker>
      <div
        className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-strong px-4 py-4 text-left"
        data-loading-add-counterparty
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-fill-subtle">
          <SkeletonBlock className="size-4 rounded-full" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonBlock className="h-4 w-40 max-w-full" />
          <SkeletonBlock className="h-4 w-64 max-w-full" />
        </div>
      </div>
      <div className="flex flex-col gap-2" data-loading-combobox>
        <SkeletonBlock className="h-4 w-28" />
        <div className="flex h-[var(--input-height-xl)] w-full items-center gap-2 rounded-[var(--input-radius-xl)] border border-border-default bg-transparent px-[var(--input-padding-x-xl)]">
          <SkeletonBlock className="size-5 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-4 w-40 max-w-full" />
          </div>
          <SkeletonBlock className="size-5 shrink-0 rounded-full" />
        </div>
      </div>
    </div>
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
        <CounterpartyPickerSkeleton />
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
  return <WorkspaceTablePageSkeleton layout="counterparty-directory" />;
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
          <div className="rounded-2xl bg-surface-raised px-5 ring-1 ring-border-default">
            <DetailRowsSkeleton count={6} />
          </div>
        </section>
        <section className="space-y-3">
          <SkeletonBlock className="h-8 w-52" />
          <div className="space-y-4 rounded-2xl bg-surface-raised p-5 ring-1 ring-border-default">
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
      <Card className="flex h-full min-h-0 min-w-0 flex-col bg-surface-raised">
        <WorkspaceCardHeaderSkeleton stackActionOnMobile />
        <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col">
          <RouteTableSkeleton variant="recurring-payments" />
        </CardContent>
      </Card>
    </div>
  );
}

export function RecurringPaymentDetailSkeleton() {
  return (
    <div
      className="h-full min-h-0 w-full overflow-auto px-3 pt-6 pb-5 md:px-6 md:pb-6"
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
        <Card className="gap-4 bg-surface-raised">
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
