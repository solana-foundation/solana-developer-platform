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

export function DashboardWorkspaceOverviewPanel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn(dashboardWorkspaceOverviewPanelClassName, className)} {...props} />;
}

/**
 * Full-height bordered card that list pages render inside a
 * DashboardWorkspaceOverviewPanel: filter header, rows, and paginated footer
 * stack in a column that stretches to the panel's height.
 *
 * @param props - Standard div props; `className` is merged onto the card.
 * @returns The card element.
 */
export function DashboardWorkspaceCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-default bg-surface-raised",
        className
      )}
      {...props}
    />
  );
}
