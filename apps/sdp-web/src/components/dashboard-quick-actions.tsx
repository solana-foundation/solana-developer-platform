"use client";

import type { ReactNode } from "react";

export function DashboardQuickActions({
  left,
  right,
}: {
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex min-h-[56px] flex-wrap items-start justify-between gap-3 border-t border-[rgba(28,28,29,0.10)] pt-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">{left}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>
    </div>
  );
}
