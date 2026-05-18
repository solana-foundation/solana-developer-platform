import type { ReactNode } from "react";
import { PageFeedback } from "./page-feedback";
import { PageNav } from "./page-nav";

type NavPage = { name: string; url: string };

type TocItem = {
  title: ReactNode;
  url: string;
  depth?: number;
};

type DocsPageProps = {
  children: ReactNode;
  toc?: TocItem[];
  full?: boolean;
};

export function DocsPage({ children, toc, full }: DocsPageProps) {
  return (
    <div className={full ? "launch-docs-page is-full" : "launch-docs-page"}>
      <article className="launch-docs-article">{children}</article>
      {toc && toc.length > 0 ? (
        <aside className="launch-docs-toc" aria-label="On this page">
          <div className="launch-docs-toc-title">On this page</div>
          <nav>
            {toc.map((item) => (
              <a
                key={item.url}
                href={item.url}
                className="launch-docs-toc-link"
                style={{ paddingLeft: `${Math.max((item.depth ?? 2) - 2, 0) * 12}px` }}
              >
                {item.title}
              </a>
            ))}
          </nav>
        </aside>
      ) : null}
    </div>
  );
}

export function DocsTitle({ children }: { children: ReactNode }) {
  return <h1 className="launch-docs-title">{children}</h1>;
}

export function DocsDescription({ children }: { children?: ReactNode }) {
  if (!children) {
    return null;
  }

  return <p className="launch-docs-description">{children}</p>;
}

type DocsBodyProps = {
  children: ReactNode;
  prev?: NavPage;
  next?: NavPage;
  bare?: boolean;
};

export function DocsBody({ children, prev, next, bare }: DocsBodyProps) {
  return (
    <div className="launch-docs-body">
      {children}
      {!bare && <PageFeedback />}
      {!bare && <PageNav prev={prev} next={next} />}
    </div>
  );
}
