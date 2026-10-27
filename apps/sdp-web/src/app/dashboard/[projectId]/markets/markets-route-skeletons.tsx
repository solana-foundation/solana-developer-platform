import { cn } from "@sdp/ui/cn";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import { Fragment, type ReactNode } from "react";
import {
  PAYMENTS_TABLE_CELL,
  PAYMENTS_TABLE_HEAD,
} from "@/app/dashboard/[projectId]/payments/payments-table";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { RecordStack } from "@/components/refresh-record";
import type { DashboardFlags } from "@/flags/dashboard";
import { EARN_TABLE, EARN_TABLE_FRAME, type EarnTableColumns } from "./earn/earn-table-layout";
import { EMBEDDED_YIELD_STRATEGY_COLUMNS } from "./earn/embedded-yield-layout";
import {
  TREASURY_POSITION_COLUMNS,
  TREASURY_POSITIONS_BODY,
  TREASURY_STRATEGIES_BODY,
  TREASURY_STRATEGY_COLUMNS,
  TREASURY_WALLET_GRID,
  TREASURY_WALLETS_BODY,
} from "./treasury-solutions/treasury-layout";

const TREASURY_TILE_FIGURE_SKELETON_IDS = ["cash", "deployed"];
const TREASURY_TABLE_SKELETON_ROW_IDS = ["one", "two", "three", "four"];
const EARN_PATH_SKELETON_IDS = ["treasury", "program"];
const DVP_PATH_SKELETON_IDS = ["dvp"];

/**
 * The guide intro's lines, each hidden from the work-area width where the English copy rewraps
 * to fewer. Measured from 360px to 1440px: six lines at 360, five to 412, four to tablet widths,
 * three at 1024, two from 1100.
 */
const GUIDE_INTRO_LINES = [
  { id: "one", hidden: undefined },
  { id: "two", hidden: undefined },
  { id: "three", hidden: "@3xl:hidden" },
  { id: "four", hidden: "@xl:hidden" },
  { id: "five", hidden: "@min-[26.875rem]:hidden" },
  { id: "six", hidden: "@min-[23rem]:hidden" },
] as const satisfies readonly { id: string; hidden: string | undefined }[];

/** A landing group: its 24px heading line, then a tile per path, two to a row. */
function MarketsPathGroupSkeleton({ paths }: { paths: readonly string[] }) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex h-6 items-center">
        <SkeletonBlock className="h-4 w-24" />
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        {paths.map((id) => (
          <SkeletonBlock className="h-30 w-full rounded-control" key={id} />
        ))}
      </div>
    </section>
  );
}

/**
 * The landing's groups and a tile per path it renders: Earn's two, then DvP's. Markets runs
 * when either sub-module does, so drawing both showed a DvP tile on stage (Earn `beta`, DvP
 * `experimental`) that the page leaves out.
 */
export function MarketsLandingSkeleton({ earn, dvp }: { earn: boolean; dvp: boolean }) {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true" data-loading-layout="markets-landing">
      <RecordStack>
        {earn ? <MarketsPathGroupSkeleton paths={EARN_PATH_SKELETON_IDS} /> : null}
        {dvp ? <MarketsPathGroupSkeleton paths={DVP_PATH_SKELETON_IDS} /> : null}
      </RecordStack>
    </DashboardWorkspaceOverviewPanel>
  );
}

/** The client loading path: the shell's flag snapshot, already capped at the channel. */
export function MarketsLandingFlagsSkeleton({ flags }: { flags?: DashboardFlags }) {
  return <MarketsLandingSkeleton earn={flags?.earn ?? false} dvp={flags?.dvp ?? false} />;
}

/**
 * An Earn page's summary while it loads, as `EarnSummary` sets it: the 16px label line, the 44px
 * hero figure 6px under it, then the rule and the 24px stat line.
 */
export function EarnSummarySkeleton() {
  return (
    <section className="min-w-0" data-earn-loading="summary">
      <div className="flex h-4 items-center">
        <SkeletonBlock className="h-3 w-20" />
      </div>
      <SkeletonBlock className="mt-1.5 h-11 w-40" />
      <div className="mt-10 border-t border-border-default pt-6">
        <div className="flex h-6 items-center">
          <SkeletonBlock className="h-4 w-64 max-w-full" />
        </div>
      </div>
    </section>
  );
}

/** One custody wallet tile: the mark beside two 20px lines, then the two 36px figures. */
function TreasuryWalletTileSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col rounded-card bg-surface-tile", className)}>
      <div className="flex items-center gap-3 px-4 pt-4">
        <SkeletonBlock className="size-8 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center">
            <SkeletonBlock className="h-3.5 w-28" />
          </div>
          <div className="flex h-5 items-center">
            <SkeletonBlock className="h-3 w-16" />
          </div>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-6 border-t border-border-subtle px-4 pt-3 pb-3">
        {TREASURY_TILE_FIGURE_SKELETON_IDS.map((id) => (
          <div key={id}>
            <div className="flex h-4 items-center">
              <SkeletonBlock className="h-3 w-20" />
            </div>
            <div className="flex h-5 items-center">
              <SkeletonBlock className="h-3.5 w-14" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The tiles' first row: one tile where they stack, two where they pair, so a treasury with one
 * or two wallets loads into the footprint it ends with.
 */
export function TreasuryWalletTilesSkeleton() {
  return (
    <div className={TREASURY_WALLET_GRID} data-treasury-loading="wallets">
      <TreasuryWalletTileSkeleton />
      <TreasuryWalletTileSkeleton className="hidden @xl:flex" />
    </div>
  );
}

/**
 * An Earn table while it loads, in the same table, columns and type the rows render into: the
 * first cell's two 20px lines, every other cell's one.
 */
export function EarnTableSkeleton({ columns, rows }: { columns: EarnTableColumns; rows: number }) {
  const entries = Object.entries(columns);
  // Each block sits where its column sets its text: numbers and actions at the right.
  const lineClass = (className: string) =>
    cn("flex h-5 items-center", className.includes("text-right") && "justify-end");
  return (
    <div className={EARN_TABLE_FRAME} data-earn-loading="table">
      <Table className={EARN_TABLE}>
        <TableHeader>
          <TableRow>
            {entries.map(([id, className]) => (
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, className)} key={id}>
                <div className={lineClass(className)}>
                  <SkeletonBlock className="h-3 w-14" />
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {TREASURY_TABLE_SKELETON_ROW_IDS.slice(0, rows).map((row) => (
            <TableRow key={row}>
              {entries.map(([id, className], index) => (
                <TableCell className={cn(PAYMENTS_TABLE_CELL, className)} key={id}>
                  <div className={lineClass(className)}>
                    <SkeletonBlock className={index === 0 ? "h-3.5 w-32" : "h-3.5 w-12"} />
                  </div>
                  {index === 0 ? (
                    <div className="flex h-5 items-center">
                      <SkeletonBlock className="h-3 w-20" />
                    </div>
                  ) : null}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** An Earn section's 24px heading line over its body. */
function EarnSectionSkeleton({ children }: { children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex h-6 items-center">
        <SkeletonBlock className="h-4 w-36" />
      </div>
      {children}
    </section>
  );
}

export function TreasurySolutionsSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true" data-loading-layout="treasury">
      <RecordStack>
        <EarnSummarySkeleton />
        <EarnSectionSkeleton>
          <div className={TREASURY_WALLETS_BODY}>
            <TreasuryWalletTilesSkeleton />
          </div>
        </EarnSectionSkeleton>
        <EarnSectionSkeleton>
          <div className={TREASURY_POSITIONS_BODY}>
            <EarnTableSkeleton columns={TREASURY_POSITION_COLUMNS} rows={2} />
          </div>
        </EarnSectionSkeleton>
        <EarnSectionSkeleton>
          <div className={TREASURY_STRATEGIES_BODY}>
            <EarnTableSkeleton columns={TREASURY_STRATEGY_COLUMNS} rows={4} />
          </div>
        </EarnSectionSkeleton>
      </RecordStack>
    </DashboardWorkspaceOverviewPanel>
  );
}

/**
 * Embedded Yield while its summary loads: the live value and counts, then the strategy table's
 * heading, head and two rows, in the columns the rows render into.
 */
export function EmbeddedYieldPortfolioSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true" data-embedded-yield-loading="portfolio">
      <RecordStack>
        <EarnSummarySkeleton />
        <EarnSectionSkeleton>
          <EarnTableSkeleton columns={EMBEDDED_YIELD_STRATEGY_COLUMNS} rows={2} />
        </EarnSectionSkeleton>
      </RecordStack>
    </DashboardWorkspaceOverviewPanel>
  );
}

/**
 * The integration guide while the catalogue loads, as the page sets it: the intro, the strategy
 * picker over its facts line and strategy ID, then the server code's heading, key note, section
 * switch and code.
 */
export function EarnIntegrationGuideSkeleton() {
  return (
    <DashboardWorkspaceOverviewPanel aria-busy="true" data-embedded-yield-loading="integrate">
      <div className="flex min-w-0 flex-col gap-8">
        <div>
          {GUIDE_INTRO_LINES.map((line) => (
            <div className={cn("flex h-5 items-center", line.hidden)} key={line.id}>
              <SkeletonBlock className="h-3.5 w-full" />
            </div>
          ))}
        </div>
        <RecordStack>
          <EarnSectionSkeleton>
            <SkeletonBlock className="h-[var(--input-height-lg)] w-full rounded-control" />
            <div className="flex h-4 items-center">
              <SkeletonBlock className="h-3 w-56" />
            </div>
            {/* The strategy ID: a code block's 36px title bar over one 24px line in 14px padding,
                inside a 1px border. */}
            <SkeletonBlock className="h-22.5 w-full rounded-card" />
          </EarnSectionSkeleton>
          <EarnSectionSkeleton>
            {/* Copy all code wraps under the title on the narrowest phones, its 30px button set
                in the title row's 24px line by -4px margins. */}
            <SkeletonBlock className="-my-1 h-7.5 w-33 rounded-control @min-[23rem]:hidden" />
            {/* The API key callout: three lines on a phone, two from a 448px work area, one from
                768px, in 16px padding and a 1px border. */}
            <SkeletonBlock className="h-23.5 w-full rounded-card @md:h-18.5 @3xl:h-13.5" />
            <SkeletonBlock className="h-7 w-full rounded-control @2xl:w-96" />
            <div className="flex min-w-0 flex-col gap-3">
              <div>
                <div className="flex h-5 items-center">
                  <SkeletonBlock className="h-3.5 w-full" />
                </div>
                <div className="flex h-5 items-center @xl:hidden">
                  <SkeletonBlock className="h-3.5 w-2/3" />
                </div>
              </div>
              {/* The code block: the guide's 36rem viewport under its 36px title bar, inside a
                  1px border. */}
              <SkeletonBlock className="h-[calc(36rem+2.375rem)] w-full rounded-card" />
            </div>
          </EarnSectionSkeleton>
        </RecordStack>
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
            <SkeletonBlock className="h-10 w-full rounded-[0.625rem]" />
            <SkeletonBlock className="h-10 w-full rounded-[0.625rem]" />
            <SkeletonBlock className="h-9 w-full rounded-[0.5rem] md:w-[5.6875rem]" />
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
                    <div className="flex h-[1.3125rem] items-center">
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
                  <SkeletonBlock className="h-5 w-32 rounded-[0.375rem]" />
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
        <div className="flex h-[1.03125rem] items-center">
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
            <SkeletonBlock className="h-5 w-28 rounded-[0.375rem]" />
            {/* Created and Expires: two facts that wrap onto two lines when narrow. */}
            <div className="flex flex-wrap items-center gap-3">
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-4 w-52" />
            </div>
          </div>
          <div>
            <div className="flex h-[1.625rem] items-center">
              <SkeletonBlock className="h-4 w-56 max-w-full" />
            </div>
            <div className="mt-1 flex h-[1.421875rem] items-center">
              <SkeletonBlock className="h-3.5 w-[30rem] max-w-full" />
            </div>
            <div className="flex h-[1.421875rem] items-center sm:hidden">
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
                <div className="mt-0.5 flex h-[1.21875rem] items-center">
                  <SkeletonBlock className="h-3 w-80 max-w-full" />
                </div>
                {/* The hint runs to four lines beside the button when narrow. */}
                {DVP_HINT_WRAP_LINE_IDS.map((line) => (
                  <div className="flex h-[1.21875rem] items-center sm:hidden" key={line}>
                    <SkeletonBlock className="h-3 w-4/5" />
                  </div>
                ))}
              </div>
              <SkeletonBlock
                className={
                  id === "settle"
                    ? "h-10 w-[4.875rem] shrink-0 rounded-[0.625rem]"
                    : "h-10 w-[8.25rem] shrink-0 rounded-[0.625rem]"
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
        <div className="flex h-[2.3125rem] items-center justify-between gap-3 sm:h-[2.125rem]">
          {/* The label wraps to two lines beside the tabs when narrow. */}
          <SkeletonBlock className="h-7 w-40 min-w-0 sm:h-3.5 sm:w-56" />
          <SkeletonBlock className="h-[2.125rem] w-72 shrink-0 rounded-lg sm:w-80" />
        </div>
        <SkeletonBlock className="h-12 w-full rounded-[0.75rem]" />
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <SkeletonBlock className="h-3.5 w-24" />
          <SkeletonBlock className="h-12 w-full rounded-[0.75rem]" />
        </div>
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-3.5 w-12" />
          <SkeletonBlock className="h-12 w-full rounded-[0.75rem]" />
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
                <div className="mt-1 flex h-[1.21875rem] items-center">
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
          <SkeletonBlock className="h-10 w-[4.4375rem] rounded-[0.625rem]" />
          <SkeletonBlock className="h-10 w-[6.25rem] rounded-[0.625rem]" />
        </div>
      </div>
    </div>
  );
}
