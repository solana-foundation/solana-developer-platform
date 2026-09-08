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

/**
 * Primary sibling-route navigation. Query-param workspace tabs remain separate.
 * Links, so the design-system Tabs (value-driven buttons) don't fit, but styled
 * with the same md-size tab tokens so a route tab is indistinguishable from a
 * header tab.
 */
export function DashboardRouteTabs({
  ariaLabel,
  pathname,
  tabs,
}: DashboardRouteTabsConfig & { pathname: string }) {
  const currentPathname = normalizePathname(pathname);

  return (
    <nav aria-label={ariaLabel} className="flex min-w-0 flex-row">
      {tabs.map((tab) => {
        const isActive = currentPathname === normalizePathname(tab.href);
        return (
          <Link
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative inline-flex items-center justify-center leading-none tracking-wide",
              "px-[var(--tab-padding-x-md)] py-[var(--tab-padding-y-md)] text-[length:var(--text-button-md)]",
              "font-[number:var(--tab-weight-idle)] text-[var(--tab-text-idle)]",
              "transition-[color,font-weight] duration-150 ease-out motion-reduce:transition-none",
              "hover:text-[var(--tab-text-hover)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)]",
              isActive &&
                "font-[number:var(--tab-weight-active)] text-[var(--tab-text-active)] after:absolute after:inset-x-[var(--tab-padding-x-md)] after:bottom-0 after:h-[var(--tab-indicator-height)] after:bg-[var(--tab-indicator-color)]"
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
