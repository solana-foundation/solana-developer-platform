"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

interface PageTabsProps {
  tabs: Array<{ id: string; label: string }>;
  activeTab: string;
  onTabChange: (id: string) => void;
  layoutId?: string;
  className?: string;
}

export function PageTabs({
  tabs,
  activeTab,
  onTabChange,
  layoutId = "page-tab-active-underline",
  className,
}: PageTabsProps) {
  return (
    <div className={cn("inline-flex items-end gap-8", className)}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "relative cursor-pointer pb-5 text-[16px] leading-[24px] font-semibold transition-colors",
              isActive
                ? "text-text-high"
                : "text-text-low hover:text-text-medium"
            )}
          >
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="absolute right-0 bottom-[-1px] left-0 h-[1.5px] bg-[rgba(28,28,29,0.88)]"
                transition={{ type: "spring", stiffness: 500, damping: 36, mass: 0.6 }}
              />
            )}
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
