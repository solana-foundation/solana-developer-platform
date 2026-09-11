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
import { cn } from "@/lib/utils";

// Mirrors the configured workspace with one private wallet selected, which is
// the page most visits settle into. Built on the same Card and Table parts as
// the settled page so padding, gaps and row heights match by construction.

// "RPC", "Prover", "Photon indexer".
const HEALTH_LABEL_WIDTHS = ["w-7", "w-10", "w-24"];
// Withdraw, Private transfer, Merge, Move: each inactive tab's label width.
const COMPOSER_TAB_LABEL_WIDTHS = ["w-[62px]", "w-[100px]", "w-[42px]", "w-[35px]"];
const WALLET_HEAD_WIDTHS = [
  { cell: "w-[22%]", label: "w-10" },
  { cell: "w-[20%]", label: "w-24" },
  { cell: "w-[22%]", label: "w-28" },
  { cell: "w-[22%]", label: "w-12" },
  { cell: "w-[14%]", label: "w-9" },
];
const WALLET_ROWS = [
  { id: "wallet-1", name: "w-28", backing: "w-12", badge: "w-[53px]" },
  { id: "wallet-2", name: "w-24", backing: "w-10", badge: "w-[60px]" },
];
const BALANCE_ROWS = [
  { id: "balance-1", amount: "w-12", notes: false, usd: "w-14" },
  { id: "balance-2", amount: "w-16", notes: true, usd: "w-14" },
];
const ACTIVITY_HEADS = [
  { id: "operation", width: "w-16" },
  { id: "state", width: "w-9" },
  { id: "amount", width: "w-14" },
  { id: "ring", width: "w-8" },
  { id: "created", width: "w-14" },
  { id: "action", width: "w-12" },
];
const ACTIVITY_ROWS = [
  { id: "activity-1", op: "w-10", state: "w-[79px]", action: false },
  { id: "activity-2", op: "w-14", state: "w-[51px]", action: true },
  { id: "activity-3", op: "w-28", state: "w-[79px]", action: false },
];

/** One line of text-sm copy: a 20px line box holding a bar where the glyphs sit. */
function TextLine({ className }: { className: string }) {
  return (
    <span className="flex h-5 items-center">
      <SkeletonBlock className={cn("h-3.5", className)} />
    </span>
  );
}

/** A card title's 24px line. */
function TitleLine({ className }: { className: string }) {
  return (
    <span className="flex h-6 items-center">
      <SkeletonBlock className={cn("h-5", className)} />
    </span>
  );
}

/**
 * A labelled input or select: label, then the 40px control with its value and
 * chevron. `compact` matches the `Label` component, whose line is 14px rather
 * than the 20px of a plain text-sm label.
 */
function FieldSkeleton({
  className,
  label = "text",
  labelWidth,
  valueWidth,
  chevron = false,
}: {
  className: string;
  label?: "text" | "compact";
  labelWidth: string;
  valueWidth: string;
  chevron?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label === "compact" ? (
        <span className="flex h-3.5 items-center">
          <SkeletonBlock className={cn("h-3", labelWidth)} />
        </span>
      ) : (
        <TextLine className={labelWidth} />
      )}
      <div className="flex h-10 items-center justify-between gap-2 rounded-[10px] bg-fill px-3">
        <SkeletonBlock className={cn("h-3.5", valueWidth)} />
        {chevron ? <SkeletonBlock className="size-3.5 rounded-sm" /> : null}
      </div>
    </div>
  );
}

function HealthStripSkeleton() {
  return (
    <div
      className="rounded-[var(--sdp-surface-radius)] bg-surface-raised px-4 py-2.5 shadow-sm ring-1 ring-border-default"
      data-loading-section="health"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <TextLine className="w-12" />
        {HEALTH_LABEL_WIDTHS.map((width) => (
          <div className="flex items-center gap-2" key={width}>
            <SkeletonBlock className="size-2 rounded-full" />
            <TextLine className={width} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RingCardSkeleton() {
  return (
    <Card data-loading-section="rings">
      <CardHeader>
        <TitleLine className="w-32" />
        <div>
          <TextLine className="w-full" />
          <TextLine className="w-full" />
          <TextLine className="w-3/5" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* "View custom rings" with its count badge. */}
        <div className="flex h-10 w-fit items-center gap-2 rounded-[10px] bg-fill px-[18px]">
          <SkeletonBlock className="h-3.5 w-32" />
          <SkeletonBlock className="h-5 w-6 rounded-sm" />
        </div>
        <div className="flex flex-col gap-2">
          <div>
            <TextLine className="w-full" />
            <TextLine className="w-1/4" />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <FieldSkeleton
              className="min-w-48"
              label="compact"
              labelWidth="w-16"
              valueWidth="w-14"
            />
            <FieldSkeleton
              className="min-w-96"
              label="compact"
              labelWidth="w-24"
              valueWidth="w-64"
            />
            <SkeletonBlock className="h-10 w-[179px] rounded-[10px]" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PrivateWalletsSkeleton() {
  return (
    <Card className="min-w-0" data-loading-section="wallets">
      <CardHeader>
        <TitleLine className="w-36" />
        <TextLine className="w-72 max-w-full" />
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <FieldSkeleton className="min-w-56" labelWidth="w-32" valueWidth="w-28" chevron />
          <FieldSkeleton className="min-w-48" label="compact" labelWidth="w-20" valueWidth="w-24" />
          <SkeletonBlock className="h-10 w-[84px] rounded-[10px]" />
        </div>
        <hr className="border-border-default" role="presentation" />
        <div className="min-w-0 overflow-x-auto">
          <Table className="min-w-0 [&_table]:table-fixed">
            <TableHeader>
              <TableRow>
                {WALLET_HEAD_WIDTHS.map(({ cell, label }) => (
                  <TableHead className={cell} key={cell + label}>
                    <TextLine className={label} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {WALLET_ROWS.map((row) => (
                <TableRow data-loading-row="wallet" key={row.id}>
                  <TableCell>
                    <TextLine className={row.name} />
                  </TableCell>
                  <TableCell>
                    <TextLine className={row.backing} />
                  </TableCell>
                  <TableCell>
                    {/* Shortened shielded address, then its copy button. */}
                    <span className="flex items-center gap-1">
                      <TextLine className="w-24" />
                      <span className="flex size-7 items-center justify-center">
                        <SkeletonBlock className="size-3 rounded-sm" />
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <TextLine className="w-14" />
                  </TableCell>
                  <TableCell>
                    <SkeletonBlock className={cn("h-5 rounded-sm", row.badge)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function WalletOverviewSkeleton() {
  return (
    <Card data-loading-section="overview">
      <CardHeader>
        <TitleLine className="w-36" />
        <CardAction>
          {/* The refresh icon button. */}
          <span className="flex size-7 items-center justify-center">
            <SkeletonBlock className="size-4 rounded-sm" />
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <hr className="border-border-default" role="presentation" />
        <span className="flex h-4 items-center">
          <SkeletonBlock className="h-3 w-28" />
        </span>
        <div className="flex flex-col gap-2">
          <span className="flex h-8 items-center">
            <SkeletonBlock className="h-7 w-32" />
          </span>
          <div className="flex flex-col gap-0.5">
            {BALANCE_ROWS.map((row) => (
              <div className="flex items-center justify-between gap-x-3" key={row.id}>
                <span className="flex items-center gap-2">
                  <TextLine className={row.amount} />
                  {row.notes ? <SkeletonBlock className="h-3 w-12" /> : null}
                </span>
                <TextLine className={row.usd} />
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ComposerSkeleton() {
  return (
    <Card data-loading-section="composer">
      <CardHeader>
        <TitleLine className="w-28" />
        <TextLine className="w-80 max-w-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="inline-flex w-fit rounded-md border border-border-default p-0.5">
          <SkeletonBlock className="h-8 w-16 rounded-sm" />
          {COMPOSER_TAB_LABEL_WIDTHS.map((width) => (
            <span className="flex h-8 items-center px-3" key={width}>
              <SkeletonBlock className={cn("h-3.5", width)} />
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <FieldSkeleton className="min-w-48" labelWidth="w-10" valueWidth="w-8" chevron />
          <FieldSkeleton className="min-w-48" labelWidth="w-14" valueWidth="w-8" />
          <FieldSkeleton className="min-w-48" labelWidth="w-8" valueWidth="w-20" chevron />
        </div>
        <TextLine className="w-56" />
        <SkeletonBlock className="h-10 w-[86px] rounded-[10px]" />
      </CardContent>
    </Card>
  );
}

function ActivitySkeleton() {
  return (
    <Card data-loading-section="activity">
      <CardHeader>
        <TitleLine className="w-20" />
        <TextLine className="w-72 max-w-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Table>
          <TableHeader>
            <TableRow>
              {ACTIVITY_HEADS.map(({ id, width }) => (
                <TableHead key={id}>
                  <TextLine className={width} />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ACTIVITY_ROWS.map((row) => (
              <TableRow data-loading-row="activity" key={row.id}>
                <TableCell>
                  <TextLine className={row.op} />
                </TableCell>
                <TableCell>
                  <SkeletonBlock className={cn("h-5 rounded-sm", row.state)} />
                </TableCell>
                <TableCell>
                  <TextLine className="w-14" />
                </TableCell>
                <TableCell>
                  <TextLine className="w-20" />
                </TableCell>
                <TableCell>
                  <TextLine className="w-36" />
                </TableCell>
                <TableCell>
                  {/* The small Retry button, 36px tall. */}
                  {row.action ? <SkeletonBlock className="h-9 w-[60px] rounded-lg" /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Everything below the devnet banner. The workspace shows this while it reads
 * its setup, so the route skeleton carries straight through to the data.
 */
export function HeliusRingsWorkspaceSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-loading-section="workspace">
      <HealthStripSkeleton />
      <RingCardSkeleton />
      <PrivateWalletsSkeleton />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <WalletOverviewSkeleton />
        <ComposerSkeleton />
      </div>
      <ActivitySkeleton />
    </div>
  );
}

/** The whole route: page frame, devnet banner, then the workspace. */
export function HeliusRingsSkeleton() {
  return (
    <div
      className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8"
      data-loading-layout="helius-rings"
      aria-busy="true"
    >
      <div className="flex flex-col gap-6">
        <div
          className="rounded-xl border border-border-default px-4 py-3"
          data-loading-section="devnet-banner"
        >
          <TextLine className="w-[38rem] max-w-full" />
        </div>
        <HeliusRingsWorkspaceSkeleton />
      </div>
    </div>
  );
}
