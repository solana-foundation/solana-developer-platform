import type { Item, Node, Root } from "fumadocs-core/page-tree";

/**
 * The URLs the sidebar lists at its top level: its pages and its folders' own pages.
 *
 * @param tree - The page tree the sidebar renders.
 * @returns Those URLs, in sidebar order.
 */
export function topLevelUrlsOf(tree: Root): string[] {
  return tree.children.flatMap((node) => {
    if (node.type === "page") return [node.url];
    if (node.type === "folder" && node.index) return [node.index.url];
    return [];
  });
}

/**
 * The top-level sidebar page a page's path sits under: the longest top-level URL its path
 * extends. The home is nobody's section, since every path extends `/docs`.
 *
 * @param topLevelUrls - The sidebar's top-level URLs (`topLevelUrlsOf`).
 * @param pathname - The page's path.
 * @returns That page's URL, or undefined when no top-level page holds the path.
 */
export function sectionByPath(
  topLevelUrls: readonly string[],
  pathname: string
): string | undefined {
  let section: string | undefined;
  for (const url of topLevelUrls) {
    const holds = url !== "/docs" && pathname.startsWith(`${url}/`);
    if (holds && (section === undefined || url.length > section.length)) section = url;
  }
  return section;
}

/** A page and the top-level sidebar page its breadcrumb starts at, if any. */
export type PageSection = { url: string; section: string | undefined };

/**
 * The sidebar entry each page sits under where its path alone does not say so: its breadcrumb
 * starts at a top-level page other than the one its path extends (`sectionByPath`).
 *
 * @param pages - Each page with the section its breadcrumb starts at.
 * @param topLevelUrls - The sidebar's top-level URLs (`topLevelUrlsOf`).
 * @returns Section URLs by page URL, for those pages only.
 */
export function sectionOverridesOf(
  pages: readonly PageSection[],
  topLevelUrls: readonly string[]
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const { url, section } of pages) {
    if (section !== undefined && section !== sectionByPath(topLevelUrls, url)) {
      overrides[url] = section;
    }
  }
  return overrides;
}

function sidebarItemOf(item: Item): Item {
  return { type: "page", name: item.name, url: item.url, icon: item.icon };
}

function sidebarNodeOf(node: Node): Node {
  if (node.type === "page") return sidebarItemOf(node);
  if (node.type === "separator") return { type: "separator", name: node.name, icon: node.icon };
  return {
    type: "folder",
    name: node.name,
    icon: node.icon,
    index: node.index === undefined ? undefined : sidebarItemOf(node.index),
    children: node.children.map(sidebarNodeOf),
  };
}

/**
 * The page tree with only what the sidebar draws: names, URLs, icons and nesting. Every page
 * ships the sidebar's tree, the API reference's operations included, so the ids, file paths and
 * descriptions Fumadocs keeps on each node stay on the server.
 *
 * @param tree - The source's page tree.
 * @returns The same tree, each node cut to its type, name, URL or index, icon and children.
 */
export function sidebarTreeOf(tree: Root): Root {
  return { name: tree.name, children: tree.children.map(sidebarNodeOf) };
}
