import type { ReactNode } from "react";
import { DocsBreadcrumb } from "@/components/docs-shell/breadcrumb";
import { DocsSidebar } from "@/components/docs-shell/sidebar";
import { source } from "@/lib/source";

function resolveDashboardUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_SDP_WEB_URL?.trim();
  if (configuredUrl) {
    try {
      const parsed = new URL(configuredUrl);
      if (parsed.pathname === "" || parsed.pathname === "/" || parsed.pathname === "/dashboard") {
        parsed.pathname = "/";
        parsed.search = "";
        parsed.hash = "";
      }
      return parsed.toString();
    } catch {
      return configuredUrl;
    }
  }

  return process.env.NODE_ENV !== "production" ? "http://localhost:3000/" : null;
}

export default function Layout({ children }: { children: ReactNode }) {
  const dashboardUrl = resolveDashboardUrl();

  return (
    <div className="sdp-docs-shell">
      <DocsSidebar tree={source.pageTree} dashboardUrl={dashboardUrl} />
      <main className="launch-docs-main">
        <div className="launch-docs-main-inner">
          <DocsBreadcrumb tree={source.pageTree} />
          {children}
        </div>
      </main>
    </div>
  );
}
