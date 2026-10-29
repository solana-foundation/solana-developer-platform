"use client";

import type { Node as PageTreeNode } from "fumadocs-core/page-tree";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

function getNodeKey(node: PageTreeNode) {
  if (node.type === "page") return node.url;
  if (node.type === "folder") return node.index?.url ?? String(node.name);
  return String(node.name);
}

function nodeContainsPath(node: PageTreeNode, pathname: string): boolean {
  if (node.type === "page") return node.url === pathname;
  if (node.type === "folder") {
    if (node.index?.url === pathname) return true;
    return node.children.some((child) => nodeContainsPath(child, pathname));
  }
  return false;
}

type NavigationNodeProps = {
  node: PageTreeNode;
};

/** A page tree node in the sidebar. Each level of children sits further in (globals.css). */
export function NavigationNode({ node }: NavigationNodeProps) {
  const pathname = usePathname();

  if (node.type === "separator") {
    return node.name ? (
      <div className="launch-docs-sidebar-section">
        <span>{node.name}</span>
      </div>
    ) : (
      <div className="launch-docs-sidebar-separator" />
    );
  }

  if (node.type === "page") {
    const isActive = pathname === node.url;
    return (
      <Link href={node.url} className={cn("launch-docs-nav-item", isActive && "is-active")}>
        {node.icon ? <span className="launch-docs-nav-icon">{node.icon}</span> : null}
        {node.name}
      </Link>
    );
  }

  if (node.type === "folder") {
    return <FolderNode node={node} pathname={pathname} />;
  }

  return null;
}

type FolderNodeProps = {
  node: Extract<PageTreeNode, { type: "folder" }>;
  pathname: string;
};

/** A plain click, which opens the page here rather than in another tab or window. */
function isPlainClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * A folder. Its row is one highlight, toggle included. A linked folder's link opens the folder
 * as it opens the page, and toggles it from the page itself, as the chevron does.
 */
function FolderNode({ node, pathname }: FolderNodeProps) {
  const containsPath = useMemo(() => nodeContainsPath(node, pathname), [node, pathname]);
  const [isOpen, setIsOpen] = useState(containsPath);

  useEffect(() => {
    if (containsPath) setIsOpen(true);
  }, [containsPath]);

  const folderName = typeof node.name === "string" ? node.name : String(node.name ?? "");
  const hasChildren = node.children.length > 0;
  const isActive = node.index?.url === pathname;

  return (
    <div className="launch-docs-nav-folder">
      <div className={cn("launch-docs-nav-folder-row", isActive && "is-active")}>
        {node.index ? (
          <>
            <Link
              href={node.index.url}
              className="launch-docs-nav-folder-link"
              onClick={(event) => {
                if (isPlainClick(event)) setIsOpen((open) => (isActive ? !open : true));
              }}
            >
              {node.icon ? <span className="launch-docs-nav-icon">{node.icon}</span> : null}
              {node.name}
            </Link>
            {hasChildren && (
              <button
                type="button"
                className="launch-docs-nav-toggle"
                onClick={() => setIsOpen((v) => !v)}
                aria-expanded={isOpen}
                aria-label={isOpen ? `Collapse ${folderName}` : `Expand ${folderName}`}
              >
                <ChevronRight className="launch-docs-nav-chevron" aria-hidden="true" />
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="launch-docs-nav-folder-btn"
            onClick={() => setIsOpen((v) => !v)}
            aria-expanded={isOpen}
            aria-label={isOpen ? `Collapse ${folderName}` : `Expand ${folderName}`}
          >
            <span>
              {node.icon ? <span className="launch-docs-nav-icon">{node.icon}</span> : null}
              {node.name}
            </span>
            {hasChildren && (
              <ChevronRight
                className="launch-docs-nav-toggle-icon launch-docs-nav-chevron"
                aria-hidden="true"
              />
            )}
          </button>
        )}
      </div>

      {hasChildren && isOpen ? (
        <div className="launch-docs-nav-children">
          {node.children.map((child) => (
            <NavigationNode key={getNodeKey(child)} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
