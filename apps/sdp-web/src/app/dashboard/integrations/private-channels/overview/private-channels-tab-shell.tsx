"use client";

import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Pane switcher for the Overview route's two tabs, keyed off the shallow
 * `?tab=` contract (see DashboardWorkspaceTabShell). It deliberately skips that
 * shell's padded scroll panels: the Private Channels segment layout already
 * owns scrolling and gutters for every sub-page, so the panes render straight
 * into the layout's scroll container.
 */
export function PrivateChannelsTabShell({
  overview,
  playground,
}: {
  overview: ReactNode;
  playground: ReactNode;
}) {
  // Router state, not `useDashboardTab`, for the same reason as the tab strip:
  // a cross-route push arriving with `?tab=playground` must mount straight on
  // the playground pane instead of flashing the overview for a frame.
  const isPlaygroundTab = useSearchParams().get("tab") === "playground";
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {isPlaygroundTab ? playground : overview}
    </div>
  );
}
