"use client";

import {
  ArrowLeftRightIcon,
  CoinsIcon,
  EllipsisIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  WalletIcon,
} from "lucide-react";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { useTranslations } from "@/i18n/provider";
import {
  DASHBOARD_SIDE_NAV_HREFS,
  isDashboardNavItemActive,
} from "@/lib/dashboard-navigation-loading";
import { cn } from "@/lib/utils";

type BottomNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

const itemBase =
  "flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[11px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised motion-reduce:transition-none";

/**
 * Thumb-reachable navigation for the four destinations people move between most,
 * with everything else behind "More".
 *
 * Deliberately **additive**: the top bar's navigation button and the slide-over it
 * opens are untouched. The navigation-loading contract drives its pending state off
 * links rendered by `DashboardNavigationLink`, and its mobile case opens that
 * slide-over by accessible name — so this bar uses the same link component (to keep
 * pre-commit feedback) and gives "More" its own name (so there is only ever one
 * control named for opening navigation).
 *
 * The caller unmounts this while the slide-over is open rather than hiding it with
 * CSS, so a covered duplicate of each destination never sits in the accessibility
 * tree behind the overlay.
 */
export function DashboardBottomNav({
  pathname,
  onOpenMore,
}: {
  pathname: string;
  onOpenMore: () => void;
}) {
  const t = useTranslations();

  const items: BottomNavItem[] = [
    {
      label: t("Shared.dashboardShell.home"),
      href: DASHBOARD_SIDE_NAV_HREFS.home,
      icon: LayoutDashboardIcon,
    },
    {
      label: t("Shared.dashboardShell.wallets"),
      href: DASHBOARD_SIDE_NAV_HREFS.wallets,
      icon: WalletIcon,
    },
    {
      label: t("Shared.dashboardShell.payments"),
      href: DASHBOARD_SIDE_NAV_HREFS.payments,
      icon: ArrowLeftRightIcon,
    },
    {
      label: t("Shared.dashboardShell.issuance"),
      href: DASHBOARD_SIDE_NAV_HREFS.issuance,
      icon: CoinsIcon,
    },
  ];

  return (
    <nav
      aria-label={t("Shared.dashboardShell.primaryNavigation")}
      data-dashboard-bottom-nav="true"
      // pb keeps the row clear of the iOS home indicator without padding it on
      // devices that have none.
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border-default bg-[var(--sdp-shell-bg)] pb-[env(safe-area-inset-bottom)] xl:hidden"
    >
      <ul className="flex items-stretch gap-1 px-2 py-1.5">
        {items.map((item) => {
          const active = isDashboardNavItemActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex min-w-0 flex-1">
              <DashboardNavigationLink
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  itemBase,
                  active ? "text-primary" : "text-tertiary hover:text-primary"
                )}
              >
                <Icon className="size-5 shrink-0" aria-hidden="true" />
                <span className="w-full truncate text-center">{item.label}</span>
              </DashboardNavigationLink>
            </li>
          );
        })}
        <li className="flex min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpenMore}
            className={cn(itemBase, "text-tertiary hover:text-primary")}
          >
            <EllipsisIcon className="size-5 shrink-0" aria-hidden="true" />
            <span className="w-full truncate text-center">{t("Shared.dashboardShell.more")}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
