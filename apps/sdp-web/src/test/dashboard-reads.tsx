import type { ReactNode } from "react";
import { SWRConfig } from "swr";

/** A fresh dashboard read cache per render, as a new tab starts with; `renderHook`'s `wrapper`. */
export function DashboardReadsProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}
