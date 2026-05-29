"use client";

import type { Node as PageTreeNode } from "fumadocs-core/page-tree";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
  depth?: number;
};

export function NavigationNode({ node, depth = 0 }: NavigationNodeProps) {
  const pathname = usePathname();
  const containsPath = useMemo(() => nodeContainsPath(node, pathname), [node, pathname]);
  const [isOpen, setIsOpen] = useState(containsPath);

  useEffect(() => {
    if (containsPath) setIsOpen(true);
  }, [containsPath]);

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
      <Link
        href={node.url}
        className={cn("launch-docs-nav-item", isActive && "is-active")}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        {node.name}
      </Link>
    );
  }

  if (node.type === "folder") {
    const folderName = typeof node.name === "string" ? node.name : String(node.name ?? "");
    const hasChildren = node.children.length > 0;
    const isActive = node.index?.url === pathname;
    const ChevronIcon = isOpen ? ChevronDown : ChevronRight;

    return (
      <div className="launch-docs-nav-folder">
        <div className="launch-docs-nav-folder-row">
          {node.index ? (
            <>
              <Link
                href={node.index.url}
                className={cn("launch-docs-nav-folder-link", isActive && "is-active")}
                style={{ paddingLeft: `${12 + depth * 14}px` }}
              >
                {node.name}
              </Link>
              {hasChildren && (
                <button
                  type="button"
                  className="launch-docs-nav-toggle"
                  onClick={() => setIsOpen((v) => !v)}
                  aria-label={isOpen ? `Collapse ${folderName}` : `Expand ${folderName}`}
                >
                  <ChevronIcon aria-hidden="true" />
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="launch-docs-nav-folder-btn"
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              onClick={() => setIsOpen((v) => !v)}
              aria-label={isOpen ? `Collapse ${folderName}` : `Expand ${folderName}`}
            >
              <span>{node.name}</span>
              {hasChildren && (
                <ChevronIcon className="launch-docs-nav-toggle-icon" aria-hidden="true" />
              )}
            </button>
          )}
        </div>

        {hasChildren && isOpen ? (
          <div className="launch-docs-nav-children">
            {node.children.map((child) => (
              <NavigationNode key={getNodeKey(child)} node={child} depth={depth + 1} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return null;
}
