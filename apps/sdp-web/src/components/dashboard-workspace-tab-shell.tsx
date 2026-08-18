"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { selectActiveDashboardTab, useDashboardTab } from "@/lib/dashboard-url-state";

export interface DashboardWorkspaceTabShellPanel {
  /** Tab id from the route's headerTabs; the FIRST panel is the default (renders when `?tab=` is absent or names no panel). */
  id: string;
  /** Content rendered when this panel is active. */
  content: ReactNode;
  /** The panel element's full class list — the shell adds nothing, so position, padding, and scroll behavior stay the caller's. */
  className: string;
  /** Skip the enter animation whenever this panel becomes active (the wallets overview uses this to avoid re-animating server-painted content). */
  disableInitialAnimation?: boolean;
}

const tabTransition = { duration: 0.2, ease: "easeOut" } as const;

/**
 * Switches among route-configured workspace panels using the shared shallow
 * `?tab=` state, with the first panel serving as the default.
 *
 * @param props - Workspace panels in the same order as the route's header tabs.
 * @returns The active panel inside the standard animated workspace shell.
 */
export function DashboardWorkspaceTabShell({
  panels,
}: {
  panels: readonly DashboardWorkspaceTabShellPanel[];
}) {
  const activePanel = selectActiveDashboardTab(panels, useDashboardTab());

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={activePanel.id}
            initial={activePanel.disableInitialAnimation ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={tabTransition}
            className={activePanel.className}
          >
            {activePanel.content}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
