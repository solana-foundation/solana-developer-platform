"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { motion } from "framer-motion";

const tabOptions = [
  { id: "tokens", label: "Overview" },
  { id: "playground", label: "API Playground" },
] as const;

export function IssuanceHeaderTabs() {
  const { issuanceTab, setIssuanceTab } = useDashboardWorkspace();

  return (
    <div className="inline-flex items-end gap-6">
      {tabOptions.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => setIssuanceTab(tab.id)}
          className={[
            "relative pb-3 text-[16px] leading-[24px] font-medium transition-colors",
            issuanceTab === tab.id
              ? "text-[#1c1c1d]"
              : "text-[rgba(28,28,29,0.58)] hover:text-[#1c1c1d]",
          ].join(" ")}
        >
          {issuanceTab === tab.id ? (
            <motion.span
              layoutId="issuance-tab-active-underline"
              className="absolute right-0 bottom-[-1px] left-0 h-[2px] bg-[rgba(28,28,29,0.84)]"
              transition={{ type: "spring", stiffness: 500, damping: 36, mass: 0.6 }}
            />
          ) : null}
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
