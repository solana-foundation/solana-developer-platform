import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardWorkspaceProvider>
      <DashboardShell>{children}</DashboardShell>
    </DashboardWorkspaceProvider>
  );
}
