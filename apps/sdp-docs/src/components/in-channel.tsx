import type { ReactNode } from "react";
import { docsReleaseChannel, isDocsModuleInChannel, parseDocsModule } from "@/lib/release-channel";

/**
 * Renders its children only when the deployment's release channel runs `module`,
 * for module-specific passages inside pages every channel publishes. Whole pages
 * about one module take `module:` frontmatter instead. Text consumers of the raw
 * MDX resolve the same blocks with `resolveInChannelBlocks`.
 */
export function InChannel({ module, children }: { module: string; children?: ReactNode }) {
  const tagged = parseDocsModule(module, "<InChannel>");
  return isDocsModuleInChannel(tagged, docsReleaseChannel()) ? children : null;
}
