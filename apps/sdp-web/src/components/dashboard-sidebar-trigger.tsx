"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { motion } from "framer-motion";
import { PanelRight } from "lucide-react";

export function DashboardSidebarTrigger() {
  const { isSidebarOpen, setSidebarOpen } = useDashboardWorkspace();

  if (isSidebarOpen) {
    return null;
  }

  return (
    <div className="hidden items-center px-[var(--layout-shell-trigger-inline-padding)] pt-[var(--layout-shell-trigger-top-padding)] lg:flex">
      <motion.button
        type="button"
        aria-label="Open navigation"
        onClick={() => setSidebarOpen(true)}
        className="inline-flex h-[var(--layout-shell-trigger-size)] w-[var(--layout-shell-trigger-size)] items-center justify-center rounded-lg text-text-medium transition-colors hover:bg-[rgba(28,28,29,0.08)]"
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.93, rotate: 8 }}
      >
        <motion.div
          initial={{ rotate: 10 }}
          animate={{ rotate: 0 }}
          transition={{ duration: 0.18 }}
        >
          <PanelRight className="h-4 w-4" />
        </motion.div>
      </motion.button>
    </div>
  );
}
