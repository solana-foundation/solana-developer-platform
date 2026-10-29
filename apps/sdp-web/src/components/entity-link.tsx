"use client";

import { cn } from "@sdp/ui/cn";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import type { HTMLAttributeAnchorTarget, MouseEventHandler, ReactNode } from "react";

/**
 * Internal link to an entity's dashboard page: a truncating label with an
 * arrow affordance so linked entity references read as navigable.
 *
 * @param props.href - The entity page path.
 * @param props.children - The entity label.
 * @param props.onClick - Optional click handler, e.g. to stop row navigation.
 * @param props.className - Extra classes merged onto the link.
 * @param props.target - Where the link opens, e.g. `_blank` to keep the current page.
 * @param props.rel - The link's relation, e.g. `noreferrer` beside `target="_blank"`.
 * @returns The entity link element.
 */
export function EntityLink({
  href,
  children,
  onClick,
  className,
  target,
  rel,
}: {
  href: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
  target?: HTMLAttributeAnchorTarget;
  rel?: string;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      target={target}
      rel={rel}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 underline-offset-4 hover:underline focus-visible:underline",
        className
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-tertiary" />
    </Link>
  );
}
