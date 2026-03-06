import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { Suspense, type ReactNode } from "react";

function DashboardLayoutFallback({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[#e9e7de]">{children}</div>;
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<DashboardLayoutFallback>{children}</DashboardLayoutFallback>}>
      <DashboardWorkspaceProvider>
        <DashboardShell>{children}</DashboardShell>
      </DashboardWorkspaceProvider>
    </Suspense>
  );
}
