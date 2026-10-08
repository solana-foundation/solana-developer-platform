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

function UnderlineFieldSkeleton({ value = "w-48" }: { value?: string }) {
  return (
    <div className="space-y-1.5" data-loading-field>
      <SkeletonBlock className="h-3.5 w-24" />
      <div className="flex h-9 items-center border-b border-border-default">
        <SkeletonBlock className={`h-4 max-w-full ${value}`} />
      </div>
    </div>
  );
}

/**
 * A refresh flow's first step: the step name and bar, its fields, and the footer band pinned
 * to the bottom of the viewport, as WizardFrame lays them out.
 */
function FlowPageSkeleton({
  layout,
  stepper = true,
  children,
}: {
  layout: "payments-pay" | "recurring-payment-create" | "payment-request-create";
  /** A single-page form has no step bar, and its fields sit 24px apart instead of 32. */
  stepper?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-loading-layout={layout}
      data-loading-wizard
      aria-busy="true"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-9 pb-10 md:px-6">
        <div className="mx-auto w-full max-w-flow">
          {stepper ? (
            <div className="mb-12 space-y-2" data-loading-stepper>
              <div className="flex items-center justify-between gap-3">
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="h-4 w-20" />
              </div>
              <SkeletonBlock className="h-1 w-full rounded-full" />
            </div>
          ) : null}
          <div className={stepper ? "space-y-8" : "space-y-6"}>{children}</div>
        </div>
      </div>
      <div className="shrink-0 border-t border-border-subtle bg-surface px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto flex w-full max-w-flow items-center justify-end gap-3">
          <SkeletonBlock className="h-control-lg w-20 rounded-control" />
          <SkeletonBlock className="h-control-lg w-40 rounded-control" />
        </div>
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

export function CounterpartyDirectorySkeleton() {
  return <ListPageSkeleton layout="counterparty-directory" />;
}

/** Pay's details step: contact, destination, source wallet, then amount beside token. */
export function PaymentsPayPageSkeleton() {
  return (
    <FlowPageSkeleton layout="payments-pay">
      <UnderlineFieldSkeleton value="w-40" />
      <UnderlineFieldSkeleton value="w-56" />
      <UnderlineFieldSkeleton value="w-36" />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,10rem)] gap-6">
        <UnderlineFieldSkeleton value="w-24" />
        <UnderlineFieldSkeleton value="w-16" />
      </div>
    </FlowPageSkeleton>
  );
}

/** Deposit opens on its address tab: the wallet's address and QR card, then its terms. */
export function PaymentsDepositPageSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-flow space-y-10 pt-2"
      data-loading-layout="payments-deposit"
      data-loading-deposit-address
      aria-busy="true"
    >
      <div className="flex flex-col gap-6 rounded-card border border-border-default bg-fill-subtle p-6 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-4">
          <SkeletonBlock className="h-5 w-40 max-w-full" />
          <SkeletonBlock className="h-5 w-full" />
          <SkeletonBlock className="h-4 w-64 max-w-full" />
        </div>
        <SkeletonBlock className="size-28 shrink-0 rounded-control" />
      </div>
      <DetailRowsSkeleton count={3} />
    </div>
  );
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

// Transactions, Requests and Schedules keep the previous design's skeletons until they are
// redesigned. A new contact's wizard loads as it did before: its layout is unchanged.
export {
  CounterpartyCreateSkeleton,
  PaymentRequestsPageSkeleton,
  PaymentsTransactionsPageSkeleton,
  RecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton,
  TransactionsResultsSkeleton,
} from "./payments-route-skeletons";
