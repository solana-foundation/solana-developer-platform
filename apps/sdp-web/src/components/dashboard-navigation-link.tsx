"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { announceDashboardNavigation } from "@/lib/dashboard-navigation-loading";

type DashboardNavigationLinkProps = Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & {
  href: string;
};

/** Internal dashboard link that announces a real Next navigation before its RSC request settles. */
export function DashboardNavigationLink({ href, ...props }: DashboardNavigationLinkProps) {
  return (
    <Link
      {...props}
      href={href}
      data-dashboard-navigation-link="true"
      onNavigate={() => announceDashboardNavigation(href)}
    />
  );
}
