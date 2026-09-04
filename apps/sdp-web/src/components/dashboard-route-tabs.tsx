import Link from "next/link";
import { cn } from "@/lib/utils";

export interface DashboardRouteTab {
  href: string;
  label: string;
}

export interface DashboardRouteTabsConfig {
  ariaLabel: string;
  tabs: readonly DashboardRouteTab[];
}

function normalizePathname(pathname: string): string {
  return pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
}

/** Primary sibling-route navigation. Query-param workspace tabs remain separate. */
export function DashboardRouteTabs({
  ariaLabel,
  pathname,
  tabs,
}: DashboardRouteTabsConfig & { pathname: string }) {
  const currentPathname = normalizePathname(pathname);

  return (
    <nav aria-label={ariaLabel} className="flex min-w-0 items-end gap-8">
      {tabs.map((tab) => {
        const isActive = currentPathname === normalizePathname(tab.href);
        return (
          <Link
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative inline-flex h-14 items-center text-base leading-4 font-semibold text-tertiary transition-colors hover:text-primary",
              isActive &&
                "text-primary after:absolute after:inset-x-0 after:bottom-0 after:h-[1.5px] after:bg-primary"
            )}
            href={tab.href}
            key={tab.href}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
