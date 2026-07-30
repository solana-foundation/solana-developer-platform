"use client";

import {
  CircleCheckBigIcon,
  KeyRoundIcon,
  type LucideIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import { useEffect } from "react";
import { getPaymentsActions } from "@/components/dashboard-nav";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { useTranslations } from "@/i18n/provider";
import {
  DASHBOARD_SIDE_NAV_HREFS,
  isDashboardNavItemActive,
} from "@/lib/dashboard-navigation-loading";
import { cn } from "@/lib/utils";

type MoreItem = { label: string; href: string; icon?: LucideIcon };
type MoreGroup = { title: string; items: MoreItem[] };

/**
 * The destinations that did not earn a slot in the bottom bar.
 *
 * Grouped rather than listed flat: the payments sub-actions alone are six entries,
 * and an undifferentiated list of eleven is harder to scan than the slide-over it
 * replaces on this surface.
 */
function getMoreGroups(
  t: ReturnType<typeof useTranslations>,
  options: { canReadApprovals: boolean }
): MoreGroup[] {
  return [
    {
      title: t("Shared.dashboardShell.manage"),
      items: [
        {
          label: t("Shared.dashboardShell.apiKeys"),
          href: DASHBOARD_SIDE_NAV_HREFS.apiKeys,
          icon: KeyRoundIcon,
        },
        {
          label: t("Shared.dashboardShell.policies"),
          href: DASHBOARD_SIDE_NAV_HREFS.policies,
          icon: ShieldCheckIcon,
        },
        ...(options.canReadApprovals
          ? [
              {
                label: t("Shared.dashboardShell.approvals"),
                href: DASHBOARD_SIDE_NAV_HREFS.approvals,
                icon: CircleCheckBigIcon,
              },
            ]
          : []),
      ],
    },
    {
      title: t("Shared.dashboardShell.payments"),
      items: getPaymentsActions(t).map((action) => ({
        label: action.label,
        href: action.href,
        icon: action.icon,
      })),
    },
  ];
}

/**
 * Bottom sheet for everything outside the four bar destinations.
 *
 * Deliberately separate from the top bar's slide-over, which is untouched: the
 * navigation-loading contract opens that one by accessible name and then clicks a
 * destination inside it, so replacing it would break a tested flow. Tiles use
 * `DashboardNavigationLink` to keep the same pre-commit loading feedback.
 */
export function DashboardMoreSheet({
  pathname,
  canReadApprovals,
  onClose,
}: {
  pathname: string;
  canReadApprovals: boolean;
  onClose: () => void;
}) {
  const t = useTranslations();
  const groups = getMoreGroups(t, { canReadApprovals });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end xl:hidden">
      <button
        type="button"
        aria-label={t("Shared.dashboardShell.closeNavigationOverlay")}
        className="absolute inset-0 bg-primary/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Shared.dashboardShell.more")}
        data-dashboard-more-sheet="true"
        className="relative z-10 max-h-[82vh] overflow-y-auto rounded-t-3xl border-t border-border-default bg-surface-raised pb-[max(env(safe-area-inset-bottom),1rem)] shadow-lg"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 bg-surface-raised px-5 pt-5 pb-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-medium tracking-tight text-primary">
              {t("Shared.dashboardShell.more")}
            </h2>
            <p className="text-sm text-tertiary">{t("Shared.dashboardShell.moreDescription")}</p>
          </div>
          <button
            type="button"
            aria-label={t("Shared.SharedComponents.close")}
            onClick={onClose}
            className="-mr-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-strong hover:text-primary motion-reduce:transition-none"
          >
            <XIcon className="size-5" />
          </button>
        </div>

        <div className="space-y-6 px-5 pt-2">
          {groups.map((group) => (
            <section key={group.title} className="space-y-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                {group.title}
              </h3>
              <ul className="grid grid-cols-2 gap-3">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isDashboardNavItemActive(pathname, item.href);
                  return (
                    <li key={item.href} className="min-w-0">
                      <DashboardNavigationLink
                        href={item.href}
                        onClick={onClose}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-w-0 items-center gap-3 rounded-2xl border px-3 py-3 transition-colors motion-reduce:transition-none",
                          active
                            ? "border-border-strong bg-fill-subtle text-primary"
                            : "border-border-default text-secondary hover:bg-fill-subtle hover:text-primary"
                        )}
                      >
                        {Icon ? (
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-fill-subtle">
                            <Icon className="size-4" aria-hidden="true" />
                          </span>
                        ) : null}
                        <span className="min-w-0 truncate text-sm font-medium">{item.label}</span>
                      </DashboardNavigationLink>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
