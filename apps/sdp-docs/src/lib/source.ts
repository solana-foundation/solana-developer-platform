import type { Node, Root } from "fumadocs-core/page-tree";
import { loader, type VirtualFile } from "fumadocs-core/source";
import { icons } from "lucide-react";
import { createElement } from "react";
import { docs } from "@/.source/server";
import { isPagePublished, parsePageGateFields } from "./release-channel";

type FumadocsSource = {
  files: VirtualFile[] | (() => VirtualFile[]);
} & Record<string, unknown>;

const mdxSource = (
  docs as unknown as { toFumadocsSource: () => FumadocsSource }
).toFumadocsSource();
const normalizedFiles = typeof mdxSource.files === "function" ? mdxSource.files() : mdxSource.files;

/**
 * A page tagged `module: <module>` (or `rampProvider: <provider>`) in its
 * frontmatter is published only when the build's release channel publishes it
 * (src/generated/public-surface.json). Dropping it here removes it
 * from every consumer of `source`: static params (so its URL 404s), the page
 * tree, search, the sitemap and the Markdown route.
 */
function isFileInChannel(file: VirtualFile): boolean {
  if (file.type !== "page") return true;
  return isPagePublished(parsePageGateFields(file.data, file.path), file.path);
}

/**
 * Drops what a removed page leaves behind in the navigation: folders with no
 * pages and separators with no page before the next separator.
 */
function pruneNodes(nodes: Node[]): Node[] {
  const kept: Node[] = [];
  for (const node of nodes) {
    if (node.type !== "folder") {
      kept.push(node);
      continue;
    }
    const children = pruneNodes(node.children);
    if (children.length > 0 || node.index) kept.push({ ...node, children });
  }
  return kept.filter(
    (node, index) =>
      node.type !== "separator" ||
      (index + 1 < kept.length && kept[index + 1]?.type !== "separator")
  );
}

export const source = loader({
  baseUrl: "/docs",
  icon(icon) {
    if (!icon) return undefined;
    if (!(icon in icons)) {
      throw new Error(`Unknown sidebar icon "${icon}" — use a lucide-react icon name.`);
    }
    return createElement(icons[icon as keyof typeof icons]);
  },
  source: {
    ...mdxSource,
    files: normalizedFiles.filter(isFileInChannel),
  },
  plugins: [
    {
      name: "release-channel-prune",
      transformPageTree: {
        root: (root: Root): Root => ({ ...root, children: pruneNodes(root.children) }),
      },
    },
  ],
});
