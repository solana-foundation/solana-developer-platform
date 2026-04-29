"use client";

import type { Node as PageTreeNode } from "fumadocs-core/page-tree";
import {
  Activity,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CreditCard,
  FileKey,
  HeartPulse,
  KeyRound,
  Landmark,
  Rocket,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

function getPageIcon(name: string) {
  const normalized = name.toLowerCase();

  if (normalized.includes("wallet")) return WalletCards;
  if (normalized.includes("api key") || normalized.includes("key")) return KeyRound;
  if (normalized.includes("payment") || normalized.includes("transfer")) return CreditCard;
  if (normalized.includes("compliance") || normalized.includes("freeze")) return ShieldCheck;
  if (normalized.includes("project") || normalized.includes("organization")) return Landmark;
  if (
    normalized.includes("issuance") ||
    normalized.includes("token") ||
    normalized.includes("mint")
  )
    return CircleDot;
  if (normalized.includes("health")) return HeartPulse;
  if (normalized.includes("provider") || normalized.includes("setup")) return FileKey;
  if (normalized.includes("getting") || normalized.includes("start")) return Rocket;
  if (normalized.includes("reference")) return BookOpen;

  return Activity;
}

function nodeContainsPath(node: PageTreeNode, pathname: string): boolean {
  if (node.type === "page") {
    return node.url === pathname;
  }

  if (node.type === "folder") {
    return (
      node.index?.url === pathname ||
      node.children.some((child) => nodeContainsPath(child, pathname))
    );
  }

  return false;
}

function getNodeKey(node: PageTreeNode) {
  if (node.type === "page") {
    return node.url;
  }

  if (node.type === "folder") {
    return node.index?.url ?? String(node.name);
  }

  return String(node.name);
}

type NavigationNodeProps = {
  node: PageTreeNode;
  depth?: number;
};

export function NavigationNode({ node, depth = 0 }: NavigationNodeProps) {
  const pathname = usePathname();
  const initiallyOpen = useMemo(() => nodeContainsPath(node, pathname), [node, pathname]);
  const [isOpen, setIsOpen] = useState(initiallyOpen);

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
    const pageName = typeof node.name === "string" ? node.name : String(node.name ?? "");
    const Icon = getPageIcon(pageName);
    const isActive = pathname === node.url;

    return (
      <Link
        href={node.url}
        className={cn("launch-docs-nav-item", isActive && "is-active")}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        <Icon aria-hidden="true" />
        <span>{node.name}</span>
      </Link>
    );
  }

  if (node.type === "folder") {
    const folderName = typeof node.name === "string" ? node.name : String(node.name ?? "");
    const hasChildren = node.children.length > 0;
    const isActive = node.index?.url === pathname;

    return (
      <div className="launch-docs-nav-folder">
        <div className="launch-docs-nav-folder-row" style={{ paddingLeft: `${4 + depth * 14}px` }}>
          {hasChildren ? (
            <button
              type="button"
              className="launch-docs-nav-toggle"
              onClick={() => setIsOpen((value) => !value)}
              aria-label={isOpen ? `Collapse ${folderName}` : `Expand ${folderName}`}
            >
              {isOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            </button>
          ) : (
            <span className="launch-docs-nav-toggle-spacer" />
          )}

          {node.index ? (
            <Link
              href={node.index.url}
              className={cn("launch-docs-nav-folder-link", isActive && "is-active")}
            >
              {node.name}
            </Link>
          ) : (
            <span className="launch-docs-nav-folder-label">{node.name}</span>
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
