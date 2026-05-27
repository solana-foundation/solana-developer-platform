"use client";

import { AlignLeft } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

type TocItem = {
  title: ReactNode;
  url: string;
  depth?: number;
};

export function TableOfContents({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    const ids = items.map((item) => item.url.slice(1));
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(`#${entry.target.id}`);
            return;
          }
        }
      },
      { rootMargin: "0px 0px -60% 0px", threshold: 0 }
    );

    elements.forEach((el) => {
      observer.observe(el);
    });
    return () => observer.disconnect();
  }, [items]);

  return (
    <aside className="launch-docs-toc" aria-label="On this page">
      <div className="launch-docs-toc-title">
        <AlignLeft size={13} aria-hidden="true" />
        On this page
      </div>
      <nav>
        {items.map((item) => (
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
    </aside>
  );
}
