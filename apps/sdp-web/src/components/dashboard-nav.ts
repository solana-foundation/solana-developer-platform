import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  BlocksIcon,
  CircleCheckBigIcon,
  CoinsIcon,
  FileTextIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ReceiptTextIcon,
  RepeatIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
  UsersIcon,
  VenetianMaskIcon,
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
  /** Marks the children as a collapsible disclosure group (chevron + persisted open state). */
  subnavKey?: DashboardSubnavKey;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

/**
 * Collapsible sidebar groups. Every group behaves identically: chevron
 * toggle, open state persisted per group, and open-by-default when the
 * current route lives under `pathPrefix`.
 */
export const DASHBOARD_SUBNAV_GROUPS = {
  payments: { pathPrefix: "/dashboard/payments" },
  markets: { pathPrefix: "/dashboard/markets" },
} as const;

export type DashboardSubnavKey = keyof typeof DASHBOARD_SUBNAV_GROUPS;

export function dashboardSubnavId(key: DashboardSubnavKey, variant: "desktop" | "mobile"): string {
  return `${key}-subnav-${variant}`;
}

export function dashboardSubnavStorageKey(key: DashboardSubnavKey): string {
  return `sdp.dashboard.${key}-subnav-open`;
}

export function getPaymentsActions(
  t: ReturnType<typeof useTranslations>,
  privateChannelsEnabled: boolean
): SubNavItem[] {
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
    ...(privateChannelsEnabled
      ? [
          {
            label: t("Shared.dashboardShell.privateChannels"),
            href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.privateChannels,
            icon: VenetianMaskIcon,
          },
        ]
      : []),
  ];
}

/** Each Markets sub-module carries its own flag, so the group's children are whatever is enabled. */
export function getMarketsActions(
  t: ReturnType<typeof useTranslations>,
  earnEnabled: boolean
): SubNavItem[] {
  return [
    ...(earnEnabled
      ? [
          {
            label: t("Shared.dashboardShell.earn"),
            href: DASHBOARD_SIDE_NAV_HREFS.markets,
          },
        ]
      : []),
  ];
}

export function getNavSections(
  t: ReturnType<typeof useTranslations>,
  options: {
    canReadApprovals: boolean;
    earnEnabled: boolean;
    marketsEnabled: boolean;
    pendingApprovalCount: number | null;
    privateChannelsEnabled: boolean;
  }
): NavSection[] {
  const marketsActions = getMarketsActions(t, options.earnEnabled);

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
          children: getPaymentsActions(t, options.privateChannelsEnabled),
          subnavKey: "payments",
        },
        // The group needs both flags: markets off hides the module, and an
        // empty children array means no sub-module is enabled — a Markets entry
        // with nothing under it would lead nowhere.
        ...(options.marketsEnabled && marketsActions.length > 0
          ? [
              {
                label: t("Shared.dashboardShell.markets"),
                href: DASHBOARD_SIDE_NAV_HREFS.markets,
                icon: TrendingUpIcon,
                children: marketsActions,
                subnavKey: "markets" as const,
              },
            ]
          : []),
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
        {
          label: t("Shared.dashboardShell.integrations"),
          href: DASHBOARD_SIDE_NAV_HREFS.integrations,
          icon: BlocksIcon,
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
