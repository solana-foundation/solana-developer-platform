"use client";

import { useBreadcrumb } from "fumadocs-core/breadcrumb";
import type { Root } from "fumadocs-core/page-tree";
import { ChevronRight, Home } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";

type DocsBreadcrumbProps = {
  tree: Root;
};

export function DocsBreadcrumb({ tree }: DocsBreadcrumbProps) {
  const pathname = usePathname();
  const items = useBreadcrumb(pathname, tree);

  if (items.length === 0) {
    return null;
  }

  return (
    <nav className="launch-docs-breadcrumb" aria-label="Breadcrumb">
      <Link href="/docs" className="launch-docs-breadcrumb-home">
        <Home aria-hidden="true" />
        <span className="sr-only">Docs home</span>
      </Link>

      {items.map((item, index) => (
        <Fragment key={item.url ?? String(item.name)}>
          <ChevronRight aria-hidden="true" />
          {item.url && index !== items.length - 1 ? (
            <Link href={item.url}>{item.name}</Link>
          ) : (
            <span>{item.name}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
