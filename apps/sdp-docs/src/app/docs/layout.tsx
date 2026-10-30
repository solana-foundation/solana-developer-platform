import type { ReactNode } from "react";
import { DocsBreadcrumb } from "@/components/docs-shell/breadcrumb";
import { DocsSidebar } from "@/components/docs-shell/sidebar";
import { getAgentSetupOptions } from "@/lib/agent-setup";
import { resolveDashboardUrl } from "@/lib/dashboard-url";
import { source } from "@/lib/source";
// Code-fence carousels (`rotate-providers`, `rotate-token-ops`) can sit on any page.
import "@/styles/ramp-rotator.css";

export default function Layout({ children }: { children: ReactNode }) {
  const dashboardUrl = resolveDashboardUrl();

  return (
    <div className="sdp-docs-shell">
      <DocsSidebar
        tree={source.pageTree}
        dashboardUrl={dashboardUrl}
        agentSetup={getAgentSetupOptions()}
      />
      <main className="launch-docs-main">
        <div className="launch-docs-main-inner">
          <DocsBreadcrumb tree={source.pageTree} />
          {children}
        </div>
      </main>
    </div>
  );
}
