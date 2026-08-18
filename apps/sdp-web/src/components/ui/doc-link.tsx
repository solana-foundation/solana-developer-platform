import type { ReactNode } from "react";
import { resolveDocsUrl } from "@/lib/docs-url";
import { cn } from "@/lib/utils";

type DocLinkProps = {
  children: ReactNode;
  className?: string;
  /**
   * Announced to screen readers, e.g. "opens in a new tab". Required rather than
   * optional so a caller cannot quietly ship a link that retargets the tab in
   * silence, and passed in rather than read from a catalog so this primitive
   * carries no product copy of its own.
   */
  newTabHint: string;
  /** Path within the docs site. Omit to link to the docs root. */
  path?: string;
};

/**
 * A link into the documentation site.
 *
 * Docs links had been assembled ad hoc at each call site — one of them against a
 * hardcoded absolute URL — so they could not move together. This owns the target
 * and the external-link behaviour in one place.
 */
export function DocLink({ children, className, newTabHint, path }: DocLinkProps) {
  return (
    <a
      className={cn(
        "text-primary underline underline-offset-4 transition-colors hover:text-secondary motion-reduce:transition-none",
        className
      )}
      href={resolveDocsUrl(path)}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
      <span className="sr-only"> {newTabHint}</span>
    </a>
  );
}

export type { DocLinkProps };
