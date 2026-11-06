import { type ReactNode, useState } from "react";
import {
  DashboardPageTitleContext,
  type DashboardPageTitleOverride,
} from "@/components/dashboard-page-title-context";

/** Stands in for the shell's header: renders the title, badge and actions a page sets through `DashboardPageTitle`. */
export function HeaderHost({ children }: { children: ReactNode }) {
  const [header, setHeader] = useState<DashboardPageTitleOverride | null>(null);
  return (
    <DashboardPageTitleContext.Provider value={setHeader}>
      {header ? (
        <header>
          <h1>{header.title}</h1>
          {header.badge}
          {header.actions}
        </header>
      ) : null}
      {children}
    </DashboardPageTitleContext.Provider>
  );
}
