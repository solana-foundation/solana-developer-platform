import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const dashboardWorkspaceOverviewPanelClassName =
  "h-full min-h-0 w-full overflow-y-auto px-3 pt-6 pb-5 md:px-6 md:pb-6";

export function DashboardWorkspaceOverviewPanel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn(dashboardWorkspaceOverviewPanelClassName, className)} {...props} />;
}
