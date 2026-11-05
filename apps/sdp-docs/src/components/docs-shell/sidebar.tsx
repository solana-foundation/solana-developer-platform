"use client";

import type { Root } from "fumadocs-core/page-tree";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch";
import { ArrowUpRight, Menu, Search, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSetupOptions } from "@/lib/agent-setup";
import { sectionByPath, topLevelUrlsOf } from "@/lib/sidebar-section";
import { AgentSetup } from "./agent-setup";
import { NavigationNode } from "./navigation-node";

type DocsSidebarProps = {
  tree: Root;
  /** Where a page's path does not name its sidebar entry (`sidebarSectionOverrides`). */
  sectionOverrides: Record<string, string>;
  dashboardUrl: string | null;
  agentSetup: AgentSetupOptions;
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

export function DocsSidebar({
  tree,
  sectionOverrides,
  dashboardUrl,
  agentSetup,
}: DocsSidebarProps) {
  const [open, setOpen] = useState(false);
  const { setOpenSearch } = useSearchContext();
  const pathname = usePathname();
  const topLevelUrls = useMemo(() => topLevelUrlsOf(tree), [tree]);
  // The entry the current page sits under, highlighted like the page itself.
  const sectionUrl = sectionOverrides[pathname] ?? sectionByPath(topLevelUrls, pathname);
  const navRef = useRef<HTMLElement>(null);

  // A deep page's row (an API operation) can sit below the sidebar's fold: centre it when the
  // page changes, and leave the sidebar alone while the row already shows.
  useEffect(() => {
    const nav = navRef.current;
    const row = nav?.querySelector<HTMLElement>(`a[href="${CSS.escape(pathname)}"]`);
    if (!nav || !row) return;
    const navBox = nav.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < navBox.top || rowBox.bottom > navBox.bottom) {
      nav.scrollTop += rowBox.top - navBox.top - (navBox.height - rowBox.height) / 2;
    }
  }, [pathname]);

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
            <Link href="/docs" className="launch-docs-brand" onClick={() => setOpen(false)}>
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

          <button
            type="button"
            className="launch-docs-sidebar-search"
            onClick={() => setOpenSearch(true)}
          >
            <Search aria-hidden="true" />
            Search docs
            <span className="launch-docs-sidebar-search-keys">
              <kbd>⌘</kbd>
              <kbd>K</kbd>
            </span>
          </button>

          <div className="launch-docs-sidebar-actions">
            {dashboardUrl ? (
              <a href={dashboardUrl} className="launch-docs-sidebar-action">
                Dashboard
                <ArrowUpRight aria-hidden="true" />
              </a>
            ) : null}
            <AgentSetup options={agentSetup} />
          </div>
        </div>

        <nav ref={navRef} className="launch-docs-sidebar-nav" aria-label="Documentation navigation">
          {tree.children.map((node) => (
            <NavigationNode
              key={getNodeKey(node)}
              node={node}
              sectionUrl={sectionUrl}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </nav>

        <div className="launch-docs-sidebar-status">
          <div className="launch-docs-status-line">
            <span className="launch-docs-status-current">
              <span className="launch-docs-status-dot" aria-hidden="true" />
              Devnet live
            </span>
            <Link
              href="/docs/guides/go-to-mainnet"
              className="launch-docs-status-future"
              onClick={() => setOpen(false)}
            >
              Mainnet by request
            </Link>
          </div>
          <ThemeSwitch mode="light-dark-system" className="launch-docs-theme-switch" />
        </div>
      </aside>
    </>
  );
}
