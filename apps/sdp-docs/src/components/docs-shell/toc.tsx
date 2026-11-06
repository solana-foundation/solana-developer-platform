"use client";

import { AlignLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

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
    let observed: HTMLElement[] | undefined;
    let visibleIds = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && visibleIds.has(entry.target.id)) {
            setActiveId(`#${entry.target.id}`);
            return;
          }
        }
      },
      { rootMargin: "0px 0px -60% 0px", threshold: 0 }
    );

    const updateHeadings = () => {
      const headings = items.flatMap((item) => {
        const element = document.getElementById(item.url.slice(1));
        // Inactive Fumadocs panels stay mounted so search and hash links can open them.
        if (
          !element ||
          !article.contains(element) ||
          element.closest('[data-state="inactive"], [hidden]')
        ) {
          return [];
        }
        return [{ item, element }];
      });
      const elements = headings.map(({ element }) => element);
      if (
        observed?.length === elements.length &&
        observed.every((element, index) => element === elements[index])
      ) {
        return;
      }
      observed = elements;
      visibleIds = new Set(elements.map((element) => element.id));
      setVisibleItems(headings.map(({ item }) => item));
      setActiveId((current) => (visibleIds.has(current.slice(1)) ? current : ""));
      observer.disconnect();
      for (const element of elements) observer.observe(element);
    };

    updateHeadings();
    const panels = new MutationObserver(updateHeadings);
    panels.observe(article, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "hidden"],
    });
    return () => {
      panels.disconnect();
      observer.disconnect();
    };
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
