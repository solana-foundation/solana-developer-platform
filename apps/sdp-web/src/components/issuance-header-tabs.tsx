"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";

const tabOptions = [
  { id: "tokens", label: "Overview" },
  { id: "playground", label: "API Playground" },
] as const;

export function IssuanceHeaderTabs() {
  const { issuanceTab, setIssuanceTab } = useDashboardWorkspace();
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);

    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);

    return () => mediaQuery.removeEventListener("change", updateIsMobile);
  }, []);

  useEffect(() => {
    if (isMobile && issuanceTab === "playground") {
      setIssuanceTab("tokens");
    }
  }, [isMobile, issuanceTab, setIssuanceTab]);

  if (isMobile) {
    return null;
  }

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
