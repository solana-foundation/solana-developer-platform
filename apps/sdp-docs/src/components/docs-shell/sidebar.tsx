"use client";

import type { Root } from "fumadocs-core/page-tree";
import { ArrowUpRight, Menu, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { NavigationNode } from "./navigation-node";

type DocsSidebarProps = {
  tree: Root;
  dashboardUrl: string | null;
};

function getNodeKey(node: Root["children"][number]) {
  if (node.type === "page") {
    return node.url;
  }

  if (node.type === "folder") {
    return node.index?.url ?? String(node.name);
  }

  return String(node.name);
}

export function DocsSidebar({ tree, dashboardUrl }: DocsSidebarProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="launch-docs-mobile-trigger"
        onClick={() => setOpen(true)}
        aria-label="Open documentation navigation"
      >
        <Menu aria-hidden="true" />
      </button>

      {open ? (
        <button
          type="button"
          className="launch-docs-scrim"
          onClick={() => setOpen(false)}
          aria-label="Close navigation"
        />
      ) : null}

      <aside className={open ? "launch-docs-sidebar is-open" : "launch-docs-sidebar"}>
        <div className="launch-docs-sidebar-header">
          <div>
            <Link href="/docs" className="launch-docs-brand">
              <span className="launch-docs-brand-mark">
                <Image src="/icon.svg" alt="" width={24} height={24} aria-hidden="true" />
              </span>
              <span>
                <strong>Solana Developer Platform</strong>
                <small>Docs</small>
              </span>
            </Link>
          </div>

          <button
            type="button"
            className="launch-docs-mobile-close"
            onClick={() => setOpen(false)}
            aria-label="Close documentation navigation"
          >
            <X aria-hidden="true" />
          </button>

          <div className="launch-docs-sidebar-actions">
            <Link href="/" className="launch-docs-sidebar-action">
              Platform
            </Link>
            {dashboardUrl ? (
              <a href={dashboardUrl} className="launch-docs-sidebar-action">
                Dashboard
                <ArrowUpRight aria-hidden="true" />
              </a>
            ) : null}
          </div>
        </div>

        <nav className="launch-docs-sidebar-nav" aria-label="Documentation navigation">
          {tree.children.map((node) => (
            <NavigationNode key={getNodeKey(node)} node={node} />
          ))}
        </nav>
      </aside>
    </>
  );
}
