import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="sdp-docs-shell">
      <DocsLayout tree={source.pageTree}>{children}</DocsLayout>
    </div>
  );
}
