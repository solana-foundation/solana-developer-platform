"use client";

import { AlignLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { observeTableOfContents } from "@/lib/table-of-contents-observer";

type TocItem = {
  title: ReactNode;
  url: string;
  depth?: number;
};

export function TableOfContents({ items, children }: { items: TocItem[]; children?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [activeId, setActiveId] = useState("");
  const [visibleItems, setVisibleItems] = useState(items);

  useEffect(() => {
    const article = ref.current?.closest(".launch-docs-page")?.querySelector("article");
    if (!article) return;
    return observeTableOfContents(
      article,
      items,
      (visible) => {
        setVisibleItems(visible);
        setActiveId((current) => (visible.some((item) => item.url === current) ? current : ""));
      },
      setActiveId
    );
  }, [items]);

  return (
    <aside ref={ref} className="launch-docs-toc" aria-label="On this page">
      <div className="launch-docs-toc-title">
        <AlignLeft size={13} aria-hidden="true" />
        On this page
      </div>
      <nav>
        {visibleItems.map((item) => (
          <a
            key={item.url}
            href={item.url}
            className={
              activeId === item.url ? "launch-docs-toc-link is-active" : "launch-docs-toc-link"
            }
            style={{
              paddingLeft: `${Math.max((item.depth ?? 2) - 2, 0) * 10 + 12}px`,
            }}
          >
            {item.title}
          </a>
        ))}
      </nav>
      {children}
    </aside>
  );
}
