"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { dashboardWorkspaceOverviewPanelClassName } from "@/components/dashboard-workspace-panel";
import { cn } from "@/lib/utils";

interface DashboardWorkspaceTabShellProps {
  isPlaygroundTab: boolean;
  overview: ReactNode;
  playground: ReactNode;
  overviewClassName?: string;
  overviewKey?: string;
  playgroundClassName?: string;
  playgroundKey?: string;
}

const tabTransition = { duration: 0.2, ease: "easeOut" } as const;

export function DashboardWorkspaceTabShell({
  isPlaygroundTab,
  overview,
  playground,
  overviewClassName,
  overviewKey = "overview-tab",
  playgroundClassName,
  playgroundKey = "playground-tab",
}: DashboardWorkspaceTabShellProps) {
  return (
    <div className="relative h-full min-h-0 w-full">
      <AnimatePresence mode="wait">
        {isPlaygroundTab ? (
          <motion.div
            key={playgroundKey}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={tabTransition}
            className={cn("absolute inset-0 flex min-h-0 flex-col", playgroundClassName)}
          >
            {playground}
          </motion.div>
        ) : (
          <motion.div
            key={overviewKey}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={tabTransition}
            className={cn(dashboardWorkspaceOverviewPanelClassName, overviewClassName)}
          >
            {overview}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
