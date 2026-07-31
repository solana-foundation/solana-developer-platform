import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  CircleCheckBigIcon,
  CoinsIcon,
  FileTextIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ReceiptTextIcon,
  RepeatIcon,
  ShieldCheckIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import type { useTranslations } from "@/i18n/provider";
import {
  DASHBOARD_PAYMENTS_SUBNAV_HREFS,
  DASHBOARD_SIDE_NAV_HREFS,
} from "@/lib/dashboard-navigation-loading";

export type SubNavItem = {
  label: string;
  href: string;
  /** Optional so nav groups that have not been given icons keep rendering unchanged. */
  icon?: LucideIcon;
  disabled?: boolean;
};

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: number;
  external?: boolean;
  children?: SubNavItem[];
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

export const PAYMENTS_SUBNAV_IDS = {
  desktop: "payments-subnav-desktop",
  mobile: "payments-subnav-mobile",
} as const;

export function getPaymentsActions(t: ReturnType<typeof useTranslations>): SubNavItem[] {
  return [
    {
      label: t("Shared.dashboardShell.transactions"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.transactions,
      icon: ReceiptTextIcon,
    },
    {
      label: t("Shared.dashboardShell.counterparty"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.counterparty,
      icon: UsersIcon,
    },
    {
      label: t("Shared.dashboardShell.pay"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.pay,
      icon: ArrowUpRightIcon,
    },
    {
      label: t("Shared.dashboardShell.deposit"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.deposit,
      icon: ArrowDownLeftIcon,
    },
    {
      label: t("Shared.dashboardShell.requests"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.requests,
      icon: FileTextIcon,
    },
    {
      label: t("Shared.dashboardShell.recurring"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.recurring,
      icon: RepeatIcon,
    },
  ];
}

export function getNavSections(
  t: ReturnType<typeof useTranslations>,
  options: { canReadApprovals: boolean; pendingApprovalCount: number | null }
): NavSection[] {
  return [
    {
      title: t("Shared.dashboardShell.create"),
      items: [
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
      ],
    },
    {
      title: t("Shared.dashboardShell.manage"),
      items: [
        {
          label: t("Shared.dashboardShell.issuance"),
          href: DASHBOARD_SIDE_NAV_HREFS.issuance,
          icon: CoinsIcon,
        },
        {
          label: t("Shared.dashboardShell.payments"),
          href: DASHBOARD_SIDE_NAV_HREFS.payments,
          icon: ArrowLeftRightIcon,
          children: getPaymentsActions(t),
        },
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
                ...(options.pendingApprovalCount ? { badge: options.pendingApprovalCount } : {}),
              },
            ]
          : []),
      ],
    },
  ];
}

export const docsHref =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:3001/docs" : DEFAULT_SDP_DOCS_URL);
