import type { ReactNode } from "react";
import { SWRConfig } from "swr";

/**
 * An SWR cache of its own for one render; pass as `render`'s `wrapper` or wrap a tree. Without
 * it, a read one test cached (and its dedupe window) answers the next test's read.
 */
export function FreshSWRCache({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;
}
