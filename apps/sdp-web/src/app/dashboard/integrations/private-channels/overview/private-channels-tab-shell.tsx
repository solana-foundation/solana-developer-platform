"use client";

import { AnimatePresence, motion } from "motion/react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

const tabTransition = { duration: 0.2, ease: "easeOut" } as const;

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
    <div className="relative h-full min-h-0 w-full">
      <AnimatePresence mode="wait">
        {isPlaygroundTab ? (
          <motion.div
            key="private-channels-playground-tab"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={tabTransition}
            className="absolute inset-0 flex min-h-0 flex-col"
          >
            {playground}
          </motion.div>
        ) : (
          <motion.div
            key="private-channels-overview-tab"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={tabTransition}
            className="absolute inset-0 flex min-h-0 flex-col"
          >
            {overview}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
