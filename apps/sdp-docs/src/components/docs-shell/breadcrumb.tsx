import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";

export type BreadcrumbItem = { name: string; url: string };

type DocsBreadcrumbProps = {
  items: BreadcrumbItem[];
};

/** Parent pages remain visible even when the compact sidebar omits nested routes. */
export function DocsBreadcrumb({ items }: DocsBreadcrumbProps) {
  if (items.length === 0) return null;

  return (
    <nav className="launch-docs-breadcrumb" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <Fragment key={item.url}>
          {index > 0 ? <ChevronRight aria-hidden="true" /> : null}
          <Link href={item.url}>{item.name}</Link>
        </Fragment>
      ))}
    </nav>
  );
}
