import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import shared from "./homepage.module.css";
import { externalLinkProps } from "./homepage-links";

/**
 * Whether `href` leaves the app's own routes: another site, or the docs, which the app serves
 * under /docs by a rewrite. Those take a plain link, not a client-side navigation.
 */
export function leavesApp(href: string) {
  return (
    /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || /^\/docs(\/|$|[?#])/.test(href)
  );
}

/** The sections' "more" link: words over a drawn line and a flying arrow (homepage.module.css). */
export function MoreLink({
  href,
  external = false,
  className,
  children,
}: {
  href: string;
  /** Opens in a new tab, as the signup link does when it leads to the waitlist. */
  external?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const content = (
    <>
      <span className={shared.moreText}>{children}</span>
      <span className={shared.moreIcon}>
        <svg className={shared.moreArrow} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 12 12 4M6 4h6v6" />
        </svg>
      </span>
    </>
  );
  const props = { className: cn(shared.more, className), href, ...externalLinkProps(external) };
  return leavesApp(href) ? <a {...props}>{content}</a> : <Link {...props}>{content}</Link>;
}
