"use client";

import type { ReactNode } from "react";

export function DashboardQuickActions({
  left,
  right,
  compact = false,
}: {
  left?: ReactNode;
  right?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={[
        "flex flex-wrap justify-between",
        compact ? "min-h-0 items-start gap-2" : "min-h-[56px] items-end gap-3",
      ].join(" ")}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">{left}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>
    </div>
  );
}
