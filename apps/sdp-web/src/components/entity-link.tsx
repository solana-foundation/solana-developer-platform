"use client";

import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Internal link to an entity's dashboard page: a truncating label with an
 * arrow affordance so linked entity references read as navigable.
 *
 * @param props.href - The entity page path.
 * @param props.children - The entity label.
 * @param props.onClick - Optional click handler, e.g. to stop row navigation.
 * @param props.className - Extra classes merged onto the link.
 * @returns The entity link element.
 */
export function EntityLink({
  href,
  children,
  onClick,
  className,
}: {
  href: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
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
