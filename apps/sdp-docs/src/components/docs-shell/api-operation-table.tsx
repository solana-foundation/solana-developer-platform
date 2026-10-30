import type { ReactNode } from "react";

/**
 * A family's table of operations on its API reference page (scripts/lib/api-reference-page.ts).
 * Each row is one link to the operation's page, laid over the whole row, with a chevron that
 * moves on hover (globals.css). `expandDocsBlocks` writes it as the table alone.
 */
export function ApiOperationTable({ children }: { children: ReactNode }) {
  return <div className="launch-api-operation-table">{children}</div>;
}
