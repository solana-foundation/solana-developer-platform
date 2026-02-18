"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { motion } from "framer-motion";

const tabOptions = [
  { id: "tokens", label: "Tokens list" },
  { id: "playground", label: "API playground" },
] as const;

export function IssuanceHeaderTabs() {
  const { issuanceTab, setIssuanceTab } = useDashboardWorkspace();

  return (
    <div className="inline-flex rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-1">
      {tabOptions.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => setIssuanceTab(tab.id)}
          className="relative rounded-lg px-4 py-2 text-sm font-medium text-[#1c1c1d]"
        >
          {issuanceTab === tab.id ? (
            <motion.span
              layoutId="issuance-tab-active-pill"
              className="absolute inset-0 rounded-lg bg-white shadow-[0_4px_14px_rgba(28,28,29,0.08)]"
              transition={{ type: "spring", stiffness: 500, damping: 36 }}
            />
          ) : null}
          <span className="relative z-[1]">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
