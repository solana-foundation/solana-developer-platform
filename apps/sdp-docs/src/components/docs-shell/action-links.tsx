import type { ReactNode } from "react";

/**
 * A page's action links as raised chips, such as the Postman collection's download (globals.css
 * gives a `download` link its icon and a JSON one braces). `expandDocsBlocks` writes the links
 * alone.
 */
export function ActionLinks({ children }: { children: ReactNode }) {
  return <div className="launch-docs-action-links">{children}</div>;
}
