"use client";

import { cn } from "@/lib/utils";

export interface SectionTab<TId extends string> {
  id: TId;
  label: string;
}

export function SectionTabs<TId extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly SectionTab<TId>[];
  value: TId;
  onChange: (value: TId) => void;
}) {
  return (
    <div role="tablist" className="flex items-center border-b border-border-default">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "-mb-px inline-flex items-center justify-center border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            value === tab.id
              ? "border-primary text-primary"
              : "border-transparent text-tertiary hover:text-primary"
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
