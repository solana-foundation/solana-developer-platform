import { Fragment } from "react";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const BALANCE_SKELETON_IDS = ["one", "two", "three"];
const STRATEGY_SKELETON_IDS = ["one", "two", "three", "four", "five"];
const TREASURY_SECTION_SKELETON_IDS = ["one", "two"];
const LANDING_PATH_SKELETON_IDS = ["treasury", "program", "dvp"];
const INTEGRATION_SECTION_SKELETON_IDS = ["client", "deposit", "portfolio", "withdraw"];

export function MarketsLandingSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="max-w-3xl">
          <SkeletonBlock className="h-3 w-28" />
          <SkeletonBlock className="mt-3 h-4 w-[32rem] max-w-full" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {LANDING_PATH_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-40 w-full rounded-2xl" key={id} />
          ))}
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function TreasurySolutionsSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-16">
        <div className="grid gap-2 sm:grid-cols-3">
          {BALANCE_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-[121px] rounded-xl" key={`summary-${id}`} />
          ))}
        </div>
        <section>
          <div className="flex items-center justify-between gap-4">
            <SkeletonBlock className="h-6 w-36" />
            <SkeletonBlock className="h-7 w-16 rounded-md" />
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-3">
            {BALANCE_SKELETON_IDS.map((id) => (
              <SkeletonBlock className="h-[175px] rounded-2xl" key={`wallet-${id}`} />
            ))}
          </div>
        </section>
        {TREASURY_SECTION_SKELETON_IDS.map((section) => (
          <section key={section}>
            <SkeletonBlock className="h-6 w-40" />
            <div className="mt-4 overflow-hidden rounded-2xl border border-border-default">
              {STRATEGY_SKELETON_IDS.slice(0, 3).map((id) => (
                <SkeletonBlock className="h-[60px] w-full rounded-none" key={`${section}-${id}`} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function EmbeddedYieldPortfolioSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div
        className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 pt-3"
        data-embedded-yield-loading="portfolio"
      >
        <div className="flex items-center justify-between gap-4">
          <SkeletonBlock className="h-6 w-48" />
          <SkeletonBlock className="h-6 w-20 rounded-md" />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {BALANCE_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-44 rounded-2xl" key={`portfolio-${id}`} />
          ))}
        </div>
        <SkeletonBlock className="h-[302px] w-full rounded-2xl" />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function EarnIntegrationGuideSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true">
      <div className="mx-auto w-full max-w-5xl space-y-5" data-embedded-yield-loading="integrate">
        <SkeletonBlock className="h-8 w-28 rounded-md" />
        <div className="max-w-3xl">
          <SkeletonBlock className="h-3 w-32" />
          <SkeletonBlock className="mt-3 h-7 w-72 max-w-full" />
          <SkeletonBlock className="mt-3 h-4 w-[38rem] max-w-full" />
        </div>
        <section className="rounded-xl border border-border-default bg-surface-raised p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-5 w-36" />
              <SkeletonBlock className="mt-2 h-4 w-80 max-w-full" />
            </div>
            <SkeletonBlock className="h-8 w-40 rounded-md" />
          </div>
          <SkeletonBlock className="mt-6 h-12 w-full rounded-xl" />
          <SkeletonBlock className="mt-4 h-28 w-full rounded-xl" />
        </section>
        <div className="grid grid-cols-4 gap-2">
          {INTEGRATION_SECTION_SKELETON_IDS.map((id) => (
            <SkeletonBlock className="h-9 w-full rounded-lg" key={id} />
          ))}
        </div>
        <section>
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="mt-2 h-4 w-[34rem] max-w-full" />
          <SkeletonBlock className="mt-6 h-56 w-full rounded-xl" />
        </section>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

const DVP_ROW_SKELETON_IDS = ["one", "two", "three", "four", "five"];
const DVP_TABLE_COLUMN_IDS = ["status", "asset", "cash", "parties", "created", "open"];
const DVP_PARTY_ROLE_IDS = ["seller", "buyer"];
const DVP_LEG_SKELETON_IDS = ["a", "b"];
const DVP_CLOSE_ACTION_IDS = ["settle", "cancel"];
const DVP_HINT_WRAP_LINE_IDS = ["two", "three", "four"];
const DVP_CREATE_STEP_IDS = ["parties", "review"];

/** A leg cell in the trades table: direction arrow, token mark, "held / target SYMBOL". */
function DvpLegCellSkeleton({ textClassName }: { textClassName: string }) {
  return (
    <div className="flex items-center gap-2">
      <SkeletonBlock className="size-3.5 shrink-0 rounded-sm" />
      <SkeletonBlock className="size-6 shrink-0 rounded-full" />
      <SkeletonBlock className={textClassName} />
    </div>
  );
}

export function DvpTradesSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      aria-busy="true"
      className="flex flex-col gap-4"
      data-loading-layout="dvp-trades"
    >
      {/* The section heading over the card, at its 24px line box. */}
      <div className="flex h-6 items-center">
        <SkeletonBlock className="h-4 w-16" />
      </div>
      <DashboardWorkspaceCard>
        {/* The toolbar grid the page opens with: search, status select, create. */}
        <div className="border-b border-border-default p-3">
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-[minmax(280px,1fr)_190px_auto]">
            <SkeletonBlock className="h-10 w-full rounded-[10px]" />
            <SkeletonBlock className="h-10 w-full rounded-[10px]" />
            <SkeletonBlock className="h-9 w-full rounded-[8px] md:w-[91px]" />
          </div>
        </div>
        {/* The same Table the rows render into, so header height, cell padding
            and row dividers come from the component rather than a guess. */}
        <Table className="rounded-none border-0">
          <TableHeader>
            <TableRow>
              {DVP_TABLE_COLUMN_IDS.map((id) => (
                <TableHead className={id === "open" ? "w-10" : undefined} key={id}>
                  {id === "open" ? null : (
                    <div className="flex h-[21px] items-center">
                      <SkeletonBlock className="h-3.5 w-16" />
                    </div>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {DVP_ROW_SKELETON_IDS.map((row) => (
              <TableRow key={row}>
                <TableCell>
                  <SkeletonBlock className="h-5 w-32 rounded-[6px]" />
                </TableCell>
                <TableCell>
                  <DvpLegCellSkeleton textClassName="h-4 w-40" />
                </TableCell>
                <TableCell>
                  <DvpLegCellSkeleton textClassName="h-4 w-32" />
                </TableCell>
                <TableCell>
                  {/* Both parties, each on a 28px line: role, name, address. */}
                  <span className="grid grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-0.5">
                    {DVP_PARTY_ROLE_IDS.map((role) => (
                      <Fragment key={role}>
                        <SkeletonBlock className="h-3 w-11" />
                        <SkeletonBlock className="h-4 w-24" />
                        <span className="flex h-7 items-center">
                          <SkeletonBlock className="h-4 w-44" />
                        </span>
                      </Fragment>
                    ))}
                  </span>
                </TableCell>
                <TableCell>
                  <SkeletonBlock className="h-4 w-28" />
                </TableCell>
                <TableCell>
                  <SkeletonBlock className="size-4" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DashboardWorkspaceCard>
    </DashboardWorkspaceOverviewPanel>
  );
}

/** One delivery card: header, amount, progress caption and bar, funding footer. */
function DvpLegCardSkeleton() {
  return (
    <section
      className="flex flex-col rounded-2xl border border-border-default bg-surface-raised p-5"
      data-loading-leg-card
    >
      <div className="flex h-6 items-center justify-between gap-3">
        <SkeletonBlock className="h-4 w-20" />
        <SkeletonBlock className="h-4 w-24" />
      </div>
      <div className="mt-5 flex min-h-10 items-center gap-3">
        <SkeletonBlock className="size-8 shrink-0 rounded-full" />
        <div>
          <div className="flex h-9 items-center">
            <SkeletonBlock className="h-7 w-36" />
          </div>
          <div className="mt-1 flex h-5 items-center">
            <SkeletonBlock className="h-3.5 w-28" />
          </div>
        </div>
      </div>
      <div className="mt-5 flex h-4 items-center justify-between">
        <SkeletonBlock className="h-3 w-20" />
        <SkeletonBlock className="h-3 w-8" />
      </div>
      <SkeletonBlock className="mt-1.5 h-1.5 w-full rounded-full" />
      <div className="mt-4 flex flex-col gap-1 rounded-lg bg-fill-subtle px-3 py-2">
        <div className="flex h-[16.5px] items-center">
          <SkeletonBlock className="h-2.5 w-24" />
        </div>
        <div className="flex h-6 items-center">
          <SkeletonBlock className="h-3 w-56 max-w-full" />
        </div>
      </div>
    </section>
  );
}

export function DvpTradeDetailSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel
      aria-busy="true"
      className="px-4 pt-6 pb-8 md:px-8 xl:px-16"
      data-loading-layout="dvp-trade-detail"
    >
      <div className="mx-auto flex w-full max-w-[63rem] flex-col gap-8">
        {/* Status badge and the created / expires facts, then whose move it is. */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SkeletonBlock className="h-5 w-28 rounded-[6px]" />
            {/* Created and Expires: two facts that wrap onto two lines when narrow. */}
            <div className="flex flex-wrap items-center gap-3">
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-4 w-52" />
            </div>
          </div>
          <div>
            <div className="flex h-[26px] items-center">
              <SkeletonBlock className="h-4 w-56 max-w-full" />
            </div>
            <div className="mt-1 flex h-[22.75px] items-center">
              <SkeletonBlock className="h-3.5 w-[30rem] max-w-full" />
            </div>
            <div className="flex h-[22.75px] items-center sm:hidden">
              <SkeletonBlock className="h-3.5 w-2/3" />
            </div>
          </div>
        </div>

        <section>
          <div className="flex min-h-7 flex-wrap items-center gap-4">
            <SkeletonBlock className="h-5 w-20" />
            <span aria-hidden className="hidden h-px flex-1 bg-border-subtle sm:block" />
            <div className="flex h-5 items-center">
              <SkeletonBlock className="h-4 w-80 max-w-full" />
            </div>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {DVP_LEG_SKELETON_IDS.map((id) => (
              <DvpLegCardSkeleton key={id} />
            ))}
          </div>
        </section>

        {/* Settle and Cancel, each a panel with its hint and a 40px button. */}
        <div className="flex flex-col gap-3">
          {DVP_CLOSE_ACTION_IDS.map((id) => (
            <section
              className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border-default bg-surface-raised px-5 py-4"
              data-loading-close-action={id}
              key={id}
            >
              <div className="min-w-0 flex-1">
                <div className="flex h-5 items-center">
                  <SkeletonBlock className="h-3.5 w-20" />
                </div>
                <div className="mt-0.5 flex h-[19.5px] items-center">
                  <SkeletonBlock className="h-3 w-80 max-w-full" />
                </div>
                {/* The hint runs to four lines beside the button when narrow. */}
                {DVP_HINT_WRAP_LINE_IDS.map((line) => (
                  <div className="flex h-[19.5px] items-center sm:hidden" key={line}>
                    <SkeletonBlock className="h-3 w-4/5" />
                  </div>
                ))}
              </div>
              <SkeletonBlock
                className={
                  id === "settle"
                    ? "h-10 w-[78px] shrink-0 rounded-[10px]"
                    : "h-10 w-[132px] shrink-0 rounded-[10px]"
                }
              />
            </section>
          ))}
        </div>

        {/* The collapsed on-chain details toggle. */}
        <div className="flex h-5 items-center gap-1.5">
          <SkeletonBlock className="size-4" />
          <SkeletonBlock className="h-3.5 w-28" />
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

/** One side of the create form: label and party tabs, party select, amount and mint. */
function DvpCreateLegSkeleton() {
  return (
    <div className="grid gap-4" data-loading-create-leg>
      <div className="grid gap-1.5">
        <div className="flex h-[37px] items-center justify-between gap-3 sm:h-[34px]">
          {/* The label wraps to two lines beside the tabs when narrow. */}
          <SkeletonBlock className="h-7 w-40 min-w-0 sm:h-3.5 sm:w-56" />
          <SkeletonBlock className="h-[34px] w-72 shrink-0 rounded-lg sm:w-80" />
        </div>
        <SkeletonBlock className="h-12 w-full rounded-[12px]" />
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <SkeletonBlock className="h-3.5 w-24" />
          <SkeletonBlock className="h-12 w-full rounded-[12px]" />
        </div>
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-3.5 w-12" />
          <SkeletonBlock className="h-12 w-full rounded-[12px]" />
        </div>
      </div>
    </div>
  );
}

export function DvpCreateSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex h-full min-h-0 w-full flex-col"
      data-loading-layout="dvp-trade-create"
    >
      {/* WizardFrame at its default max-w-3xl: two step dots and the progress
          label, one configuring stage, and the Back / Continue footer. */}
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-4">
          <div className="flex items-center gap-1.5">
            {DVP_CREATE_STEP_IDS.map((id, index) => (
              <span className="flex" data-loading-step key={id}>
                <SkeletonBlock
                  className={index === 0 ? "h-1.5 w-5 rounded-full" : "h-1.5 w-2.5 rounded-full"}
                />
              </span>
            ))}
          </div>
          <div className="flex h-4 items-center">
            <SkeletonBlock className="h-3 w-16" />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto w-full max-w-3xl pb-8">
          <div className="mb-6 space-y-1">
            <div className="flex h-8 items-center">
              <SkeletonBlock className="h-6 w-72 max-w-full" />
            </div>
            <div>
              <div className="flex h-5 items-center">
                <SkeletonBlock className="h-3.5 w-[32rem] max-w-full" />
              </div>
              <div className="flex h-5 items-center sm:hidden">
                <SkeletonBlock className="h-3.5 w-1/2" />
              </div>
            </div>
          </div>
          <div className="grid gap-6">
            <DvpCreateLegSkeleton />
            {/* The exchange strip between the two sides. */}
            <div className="my-4 flex items-center justify-center gap-5">
              <SkeletonBlock className="h-3 w-11" />
              <SkeletonBlock className="h-10 w-40 rounded-full" />
              <SkeletonBlock className="size-4 rounded-sm" />
              <SkeletonBlock className="h-10 w-40 rounded-full" />
              <SkeletonBlock className="h-3 w-11" />
            </div>
            <DvpCreateLegSkeleton />
            {/* The payout toggle card. */}
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border-default bg-surface-raised p-4">
              <div>
                <div className="flex h-5 items-center">
                  <SkeletonBlock className="h-3.5 w-64 max-w-full" />
                </div>
                <div className="mt-1 flex h-[19.5px] items-center">
                  <SkeletonBlock className="h-3 w-48 max-w-full" />
                </div>
              </div>
              <SkeletonBlock className="h-6 w-11 shrink-0 rounded-full" />
            </div>
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-border-default px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          <SkeletonBlock className="h-10 w-[71px] rounded-[10px]" />
          <SkeletonBlock className="h-10 w-[100px] rounded-[10px]" />
        </div>
      </div>
    </div>
  );
}
