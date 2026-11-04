import type { ReactNode } from "react";
import { DocsSidebar } from "@/components/docs-shell/sidebar";
import { getAgentSetupOptions } from "@/lib/agent-setup";
import { sidebarSectionOverrides } from "@/lib/breadcrumbs";
import { resolveDashboardUrl } from "@/lib/dashboard-url";
import { sidebarTreeOf } from "@/lib/sidebar-section";
import { source } from "@/lib/source";
// Code-fence carousels (`rotate-providers`, `rotate-token-ops`) can sit on any page.
import "@/styles/ramp-rotator.css";

// The pages are fixed at build time, so one pass serves every request.
const sectionOverrides = sidebarSectionOverrides();
const sidebarTree = sidebarTreeOf(source.pageTree);

export default function Layout({ children }: { children: ReactNode }) {
  const dashboardUrl = resolveDashboardUrl();

  return (
    <div className="sdp-docs-shell">
      <DocsSidebar
        tree={sidebarTree}
        sectionOverrides={sectionOverrides}
        dashboardUrl={dashboardUrl}
        agentSetup={getAgentSetupOptions()}
      />
      <main className="launch-docs-main">
        <div className="launch-docs-main-inner">{children}</div>
      </main>
    </div>
  );
}
