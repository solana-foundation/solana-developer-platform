import { DashboardShellSkeleton } from "@/components/dashboard-loading";
import { DashboardAuthGuard } from "@/components/dashboard-auth-guard";
import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { DashboardSidebarTrigger } from "@/components/dashboard-sidebar-trigger";
import { AppShell } from "@/components/layouts";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { Suspense, type ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardWorkspaceProvider>
      <Suspense fallback={<DashboardShellSkeleton />}>
        <DashboardAuthGuard>
          <AppShell sidebar={<DashboardSidebar />}>
            <DashboardSidebarTrigger />
            {children}
          </AppShell>
        </DashboardAuthGuard>
      </Suspense>
    </DashboardWorkspaceProvider>
  );
}
