import { DashboardAuthGuard } from "@/components/dashboard-auth-guard";
import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { DashboardSidebarTrigger } from "@/components/dashboard-sidebar-trigger";
import { AppShell } from "@/components/layouts";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardWorkspaceProvider>
      <DashboardAuthGuard>
        <AppShell sidebar={<DashboardSidebar />}>
          <DashboardSidebarTrigger />
          {children}
        </AppShell>
      </DashboardAuthGuard>
    </DashboardWorkspaceProvider>
  );
}
