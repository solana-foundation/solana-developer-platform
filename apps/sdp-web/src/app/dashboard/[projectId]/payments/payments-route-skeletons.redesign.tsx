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

export function CounterpartyDirectorySkeleton() {
  return <ListPageSkeleton layout="counterparty-directory" />;
}

/** One block of the contact page loading: its heading, then a few table rows under a header. */
function ContactBlockSkeleton({ rows }: { rows: number }) {
  return (
    <section className="flex flex-col gap-4 pt-4 md:pt-7.5">
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
// they are redesigned. A new contact's wizard loads as it did before: its layout is unchanged.
export {
  CounterpartyCreateSkeleton,
  PaymentRequestsPageSkeleton,
  PaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton,
  PaymentsTransactionsPageSkeleton,
  RecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton,
  TransactionsResultsSkeleton,
} from "./payments-route-skeletons";
