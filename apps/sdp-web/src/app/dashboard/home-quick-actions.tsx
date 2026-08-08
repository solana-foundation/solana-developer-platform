"use client";

import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/i18n/provider";
import type { DashboardCapabilities } from "@/lib/dashboard-access";

type QuickActionCapabilities = Pick<DashboardCapabilities, "canManageCustody" | "canManageApiKeys">;

interface QuickAction {
  href: string;
  title: string;
  body: string;
}

/**
 * What a freshly provisioned organization sees in place of a balance.
 *
 * Onboarding provisions a wallet and pushes straight to /dashboard, so a brand new
 * organization arrived at the populated hero holding nothing — a $0.00 headline and
 * no next step, which reads as a broken dashboard rather than a new one. Entry
 * points are gated on capability so a member is never offered an action that would
 * only 403.
 */
export function HomeQuickActions({ capabilities }: { capabilities: QuickActionCapabilities }) {
  const t = useTranslations();

  const actions: QuickAction[] = [
    capabilities.canManageCustody
      ? {
          href: "/dashboard/wallets",
          title: t("Shared.homeWorkspace.quickActionWallets"),
          body: t("Shared.homeWorkspace.quickActionWalletsBody"),
        }
      : null,
    capabilities.canManageApiKeys
      ? {
          href: "/dashboard/api-keys",
          title: t("Shared.homeWorkspace.quickActionApiKeys"),
          body: t("Shared.homeWorkspace.quickActionApiKeysBody"),
        }
      : null,
    {
      href: "/dashboard/payments",
      title: t("Shared.homeWorkspace.quickActionPayments"),
      body: t("Shared.homeWorkspace.quickActionPaymentsBody"),
    },
    {
      href: "/dashboard/policies",
      title: t("Shared.homeWorkspace.quickActionPolicies"),
      body: t("Shared.homeWorkspace.quickActionPoliciesBody"),
    },
  ].filter((action): action is QuickAction => action !== null);

  return (
    <Card className="min-w-0 gap-0 rounded-[18px] py-0 shadow-none">
      <CardContent className="space-y-5 px-6 py-6">
        <div className="min-w-0 space-y-2">
          <h2 className="text-[22px] leading-tight font-medium tracking-[-0.02em] text-primary">
            {t("Shared.homeWorkspace.quickActionsTitle")}
          </h2>
          <p className="text-sm text-tertiary">{t("Shared.homeWorkspace.quickActionsBody")}</p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {actions.map((action) => (
            <li key={action.href} className="min-w-0">
              <Link
                href={action.href}
                className="block min-w-0 rounded-xl border border-border-default px-4 py-3 transition-colors hover:bg-fill-subtle motion-reduce:transition-none"
              >
                <span className="block truncate text-[15px] font-medium text-primary">
                  {action.title}
                </span>
                <span className="mt-0.5 block text-[13px] text-tertiary">{action.body}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
