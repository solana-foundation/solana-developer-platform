import type { ReactNode } from "react";
import { PageFeedback } from "./page-feedback";
import { PageNav } from "./page-nav";
import { TableOfContents } from "./toc";

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
      {toc && toc.length > 0 ? <TableOfContents items={toc} /> : null}
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
