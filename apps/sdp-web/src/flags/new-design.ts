import type { ReactNode } from "react";
import { newDesign } from "@/flags";

type Page<P> = (props: P) => ReactNode | Promise<ReactNode>;

/**
 * A route that has a new-design page and a previous-design one: NEW DESIGN picks which renders,
 * per request. Lives beside the flag definitions rather than in index.ts, which may export only
 * flags (the discovery endpoint serves it wholesale).
 *
 * @param Current - The page on the new design.
 * @param Legacy - The previous design's page, from the route's `_legacy` copy.
 * @returns The route's page.
 */
export function withLegacyDesign<P extends object>(Current: Page<P>, Legacy: Page<P>) {
  // Called rather than rendered, so the route returns exactly what the chosen page returns.
  return async function DesignedPage(props: P): Promise<ReactNode> {
    return (await newDesign()) ? Current(props) : Legacy(props);
  };
}
