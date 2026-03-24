import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

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
      <DocsLayout
        tree={source.pageTree}
        links={[
          ...(dashboardUrl
            ? [
                {
                  text: "Dashboard",
                  url: dashboardUrl,
                  external: dashboardUrl.startsWith("http"),
                },
              ]
            : []),
        ]}
      >
        {children}
      </DocsLayout>
    </div>
  );
}
