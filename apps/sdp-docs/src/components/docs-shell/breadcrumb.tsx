"use client";

import type { Node as PageTreeNode, Root } from "fumadocs-core/page-tree";
import { ChevronRight, Home } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useMemo } from "react";

type FolderNode = Extract<PageTreeNode, { type: "folder" }>;

/**
 * The folders above the page at `url`, outermost first, or null when no page has it. A folder
 * whose index is the page ends the trail: on a family's table, the family is the last step.
 */
function foldersAbove(nodes: PageTreeNode[], url: string): FolderNode[] | null {
  for (const node of nodes) {
    if (node.type === "page" && node.url === url) return [];
    if (node.type !== "folder") continue;
    if (node.index?.url === url) return [node];
    const inner = foldersAbove(node.children, url);
    if (inner !== null) return [node, ...inner];
  }
  return null;
}

/**
 * Where a folder's step leads: its index, or else its first page, so a section whose meta lists
 * its overview as a child (`"pages": ["index", …]`) still links to it.
 */
function landingUrl(folder: FolderNode): string | undefined {
  if (folder.index) return folder.index.url;
  for (const child of folder.children) {
    if (child.type === "page") return child.url;
  }
  return undefined;
}

type DocsBreadcrumbProps = {
  tree: Root;
};

export function DocsBreadcrumb({ tree }: DocsBreadcrumbProps) {
  const pathname = usePathname();
  const folders = useMemo(() => foldersAbove(tree.children, pathname) ?? [], [tree, pathname]);

  if (folders.length === 0 || pathname === "/docs") {
    return null;
  }

  return (
    <nav className="launch-docs-breadcrumb" aria-label="Breadcrumb">
      <Link href="/docs" className="launch-docs-breadcrumb-home">
        <Home aria-hidden="true" />
        <span className="sr-only">Docs home</span>
      </Link>

      {folders.map((folder) => {
        const url = landingUrl(folder);
        return (
          <Fragment key={folder.$id ?? url ?? String(folder.name)}>
            <ChevronRight aria-hidden="true" />
            {url !== undefined && url !== pathname ? (
              <Link href={url}>{folder.name}</Link>
            ) : (
              <span>{folder.name}</span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
