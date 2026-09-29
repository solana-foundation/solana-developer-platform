import type { ReactNode } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
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
const RECORD_COLUMN_IDS = ["payments-loading-record-1", "payments-loading-record-2"];
interface ListSkeletonColumn {
  id: string;
  headerClassName?: string;
  cellSkeletonClassName: string;
}

type ListSkeletonVariant = "counterparty-directory";

/** The refresh lists' columns, in order, so a loading list lines up with the settled one. */
const LIST_SKELETON_COLUMNS: Record<ListSkeletonVariant, readonly ListSkeletonColumn[]> = {
  "counterparty-directory": [
    { id: "name", cellSkeletonClassName: "h-4 w-32" },
    { id: "type", cellSkeletonClassName: "h-4 w-16" },
    { id: "external-id", cellSkeletonClassName: "h-4 w-20" },
    { id: "address", cellSkeletonClassName: "h-4 w-28" },
    { id: "created", cellSkeletonClassName: "h-4 w-20" },
    {
      id: "actions",
      headerClassName: "w-12",
      cellSkeletonClassName: "ml-auto size-8 rounded-control",
    },
  ],
};

function ListToolbarSkeleton() {
  return (
    <div
      className="flex items-center gap-3 sm:flex-wrap sm:justify-between"
      data-loading-list-toolbar
    >
      <SkeletonBlock className="h-control-md w-24 shrink-0 rounded-control" />
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:justify-end">
        <SkeletonBlock className="h-control-md w-24 shrink-0 rounded-control" />
        <SkeletonBlock className="h-control-md min-w-0 flex-1 rounded-control sm:w-56 sm:flex-none" />
      </div>
    </div>
  );
}

function ListTableSkeleton({ variant }: { variant: ListSkeletonVariant }) {
  const columns = LIST_SKELETON_COLUMNS[variant];
  return (
    <div
      className="overflow-x-auto refresh:-mx-3"
      data-loading-table
      data-loading-table-variant={variant}
    >
      <Table className="min-w-[760px] rounded-none border-0">
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.id}
                className={column.headerClassName}
                data-loading-column={column.id}
              >
                {column.id === "actions" ? null : (
                  <SkeletonBlock
                    className={
                      column.headerClassName === "text-right" ? "ml-auto h-3 w-14" : "h-3 w-14"
                    }
                  />
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {TABLE_ROW_IDS.map((rowId) => (
            <TableRow key={`${variant}-${rowId}`} data-loading-table-row>
              {columns.map((column) => (
                <TableCell key={column.id}>
                  <SkeletonBlock className={`${column.cellSkeletonClassName} max-w-full`} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** A refresh list page: the filter and search row over the list, both in the title's column. */
function ListPageSkeleton({
  layout,
  children,
}: {
  layout: ListSkeletonVariant;
  children?: ReactNode;
}) {
  return (
    <DashboardWorkspaceOverviewPanel
      className="flex flex-col gap-5"
      data-loading-layout={layout}
      aria-busy="true"
    >
      <ListToolbarSkeleton />
      {children ?? <ListTableSkeleton variant={layout} />}
    </DashboardWorkspaceOverviewPanel>
  );
}

function WizardProgressSkeleton({ steps }: { steps: number }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: steps }, (_, index) => index).map((index) => (
          <SkeletonBlock
            key={index}
            className={index === 0 ? "h-1.5 w-5 rounded-full" : "h-1.5 w-2.5 rounded-full"}
          />
        ))}
      </div>
      <SkeletonBlock className="h-3 w-16" />
    </div>
  );
}

export function CounterpartyDirectorySkeleton() {
  return <ListPageSkeleton layout="counterparty-directory" />;
}

export function CounterpartyCreateSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-loading-layout="counterparty-create"
      data-loading-wizard
      aria-busy="true"
    >
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-xl">
          <WizardProgressSkeleton steps={4} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-4 md:px-6">
        <div className="mx-auto w-full max-w-xl space-y-6 pb-8">
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
      </div>
      <div className="shrink-0 border-t border-border-default px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3">
          <SkeletonBlock className="h-10 w-24 rounded-lg" />
          <SkeletonBlock className="h-10 w-24 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/** One block of the contact page loading: its heading, then a few table rows under a header. */
function ContactBlockSkeleton({ rows }: { rows: number }) {
  return (
    <section className="flex flex-col gap-4 pt-4 md:pt-10">
      <SkeletonBlock className="h-6 w-36" />
      <div className="flex flex-col">
        <div className="flex h-[30px] items-center gap-8 border-b border-border-default">
          <SkeletonBlock className="h-3 w-14" />
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="h-3 w-16" />
        </div>
        {TABLE_ROW_IDS.slice(0, rows).map((id) => (
          <div key={id} className="flex h-11 items-center gap-8 border-b border-border-subtle">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-4 w-20" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** The contact page loading: the record's two columns, then the addresses and payments blocks. */
export function CounterpartyDetailSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel data-loading-layout="counterparty-detail" aria-busy="true">
      <div className="flex flex-col gap-6">
        <div className="grid gap-x-6 md:grid-cols-2" data-loading-detail-rows>
          {RECORD_COLUMN_IDS.map((column) => (
            <div key={column}>
              {DETAIL_ROW_IDS.slice(0, 3).map((id) => (
                <div
                  key={id}
                  className="flex h-10 items-center justify-between gap-4 border-b border-border-subtle last:border-b-0"
                >
                  <SkeletonBlock className="h-4 w-20" />
                  <SkeletonBlock className="h-4 w-28" />
                </div>
              ))}
            </div>
          ))}
        </div>
        <ContactBlockSkeleton rows={1} />
        <ContactBlockSkeleton rows={3} />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

// Pay, Deposit, Transactions, Requests and Schedules keep the previous design's skeletons until
// they are redesigned.
export {
  PaymentRequestsPageSkeleton,
  PaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton,
  PaymentsTransactionsPageSkeleton,
  RecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton,
  TransactionsResultsSkeleton,
} from "./payments-route-skeletons";
