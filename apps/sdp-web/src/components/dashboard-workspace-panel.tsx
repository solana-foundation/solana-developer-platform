import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// `scrollbar-gutter: stable` reserves the scrollbar track permanently on this
// scroll container. Without it, expanding content (e.g. an issuance list row)
// summons the scrollbar, the content box loses its width, and every column
// reflows mid-animation — worse on Windows/classic scrollbars where the track
// is always ~15px. The gutter makes the scrollbar appear inside already-reserved
// space, so there's no width jump to compensate for. The `html` rule in
// globals.css is inert here because the shell locks the viewport and this inner
// panel is what actually scrolls.
export const dashboardWorkspaceOverviewPanelClassName =
  "h-full min-h-0 w-full overflow-y-auto [scrollbar-gutter:stable] px-3 pt-6 pb-5 md:px-6 md:pb-6";

/**
 * The standard playground/chrome panel: absolutely positioned to fill the
 * shell, column flex, with no padding of its own.
 */
export const dashboardWorkspacePlaygroundPanelClassName = "absolute inset-0 flex min-h-0 flex-col";

export function DashboardWorkspaceOverviewPanel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn(dashboardWorkspaceOverviewPanelClassName, className)} {...props} />;
}

/**
 * Full-height bordered card that list pages render inside a
 * DashboardWorkspaceOverviewPanel: filter header, rows, and paginated footer
 * stack in a column that stretches to the panel's height when short and grows
 * past it when rows overflow, so the panel scrolls. `shrink-0 grow` (not
 * `flex-1`) is load-bearing: `overflow-hidden` zeroes a flex item's automatic
 * min-height, and a shrinkable card would clamp to the panel and clip rows.
 *
 * @param props - Standard div props; `className` is merged onto the card.
 * @param props.clamp - Clamp the card to the panel's height instead of growing
 * past it, for pages that scroll their rows in an internal overflow region
 * (the panel then carries `overflow-hidden` instead of scrolling).
 * @returns The card element.
 */
export function DashboardWorkspaceCard({
  className,
  clamp,
  ...props
}: ComponentProps<"div"> & { clamp?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 shrink-0 grow flex-col overflow-hidden rounded-lg border border-border-default bg-surface-raised",
        clamp && "shrink basis-0",
        className
      )}
      {...props}
    />
  );
}
