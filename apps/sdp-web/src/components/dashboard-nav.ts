import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRightIcon,
  BlocksIcon,
  CircleDotDashedIcon,
  CoinsIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  TrendingUpIcon,
  WalletIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { useTranslations } from "@/i18n/provider";
import {
  DASHBOARD_MARKETS_SUBNAV_HREFS,
  DASHBOARD_PAYMENTS_SUBNAV_HREFS,
  DASHBOARD_SIDE_NAV_HREFS,
} from "@/lib/dashboard-navigation-loading";
import { resolveDocsUrl } from "@/lib/docs-url";

export type SubNavItem = {
  label: string;
  href: string;
  /** Artwork drawn in place of an icon (a pinned wallet's logo). */
  leading?: ReactNode;
  disabled?: boolean;
};

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
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
 * current route lives under `pathPrefix`. Wallets lists the pinned wallets,
 * which are there to be reached from anywhere, so it starts open everywhere.
 */
export const DASHBOARD_SUBNAV_GROUPS = {
  wallets: { pathPrefix: "/dashboard/wallets", defaultOpen: true },
  integrations: { pathPrefix: "/dashboard/integrations", defaultOpen: false },
  payments: { pathPrefix: "/dashboard/payments", defaultOpen: false },
  markets: { pathPrefix: "/dashboard/markets", defaultOpen: false },
} as const;

export type DashboardSubnavKey = keyof typeof DASHBOARD_SUBNAV_GROUPS;

export function dashboardSubnavId(key: DashboardSubnavKey, variant: "desktop" | "mobile"): string {
  return `${key}-subnav-${variant}`;
}

export function dashboardSubnavStorageKey(key: DashboardSubnavKey): string {
  return `sdp.dashboard.${key}-subnav-open`;
}

export type DashboardSubnavState = Record<DashboardSubnavKey, boolean>;

/**
 * Reveal a section's pages.
 *
 * Deliberately not a toggle. Following a top-level item is a request to go
 * there, so a second click on the section you are already in must not hide the
 * pages you are looking at (HOO-1218). The chevron remains the control that can
 * close one.
 *
 * Returns the same object when nothing changes, so a caller holding this in
 * React state does not re-render for a click that decided nothing.
 */
export function withSubnavOpen(
  current: DashboardSubnavState,
  key: DashboardSubnavKey
): DashboardSubnavState {
  return current[key] ? current : { ...current, [key]: true };
}

/** Flip one section, which is what the chevron does. */
export function withSubnavToggled(
  current: DashboardSubnavState,
  key: DashboardSubnavKey
): DashboardSubnavState {
  return { ...current, [key]: !current[key] };
}

/**
 * Payments sub-destinations. Pay only starts a payment, so a member who cannot write (a
 * read-only `viewer`) is not offered it; Deposit stays, since its address tab only reads.
 */
export function getPaymentsActions(
  t: ReturnType<typeof useTranslations>,
  canWrite: boolean
): SubNavItem[] {
  const actions: SubNavItem[] = [
    {
      label: t("Shared.dashboardShell.transactions"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.transactions,
    },
    {
      label: t("Shared.dashboardShell.contacts"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.counterparty,
    },
    {
      label: t("Shared.dashboardShell.pay"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.pay,
    },
    {
      label: t("Shared.dashboardShell.deposit"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.deposit,
    },
    {
      label: t("Shared.dashboardShell.requests"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.requests,
    },
    {
      label: t("Shared.dashboardShell.newDesign.recurring"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.recurring,
    },
  ];
  return canWrite
    ? actions
    : actions.filter((action) => action.href !== DASHBOARD_PAYMENTS_SUBNAV_HREFS.pay);
}

/**
 * Markets sub-destinations. Treasury Solutions is always listed; Embedded Yield
 * is Earn-backed and shares its gate; DvP is the first sub-module with a flag of
 * its own, so an org can have one without the other.
 */
function getMarketsActions(
  t: ReturnType<typeof useTranslations>,
  earnEnabled: boolean,
  dvpEnabled: boolean
): SubNavItem[] {
  return [
    {
      label: t("Shared.dashboardShell.treasurySolutions"),
      href: DASHBOARD_MARKETS_SUBNAV_HREFS.treasurySolutions,
    },
    ...(earnEnabled
      ? [
          {
            label: t("Shared.dashboardShell.earnProgram"),
            href: DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram,
          },
        ]
      : []),
    ...(dvpEnabled
      ? [
          {
            label: t("DashboardMarkets.dvp.navLabel"),
            href: DASHBOARD_MARKETS_SUBNAV_HREFS.dvp,
          },
        ]
      : []),
  ];
}

export function getNavSections(
  t: ReturnType<typeof useTranslations>,
  options: {
    complianceEnabled: boolean;
    custodyEnabled: boolean;
    dvpEnabled: boolean;
    earnEnabled: boolean;
    heliusRingsEnabled: boolean;
    issuanceEnabled: boolean;
    marketsEnabled: boolean;
    paymentsEnabled: boolean;
    privateChannelsEnabled: boolean;
    /** False for a read-only member: sub-destinations that only write are left out. */
    canWrite: boolean;
    /** Wallets pinned from the Wallets page, listed under Wallets in the order they were pinned. */
    walletFavorites?: SubNavItem[];
    rampsEnabled: boolean;
  }
): NavSection[] {
  const marketsActions = getMarketsActions(t, options.earnEnabled, options.dvpEnabled);

  return [
    {
      title: t("Shared.dashboardShell.create"),
      items: [
        {
          label: t("Shared.dashboardShell.newDesign.home"),
          href: DASHBOARD_SIDE_NAV_HREFS.home,
          icon: LayoutDashboardIcon,
        },
        ...(options.custodyEnabled
          ? [
              {
                label: t("Shared.dashboardShell.wallets"),
                href: DASHBOARD_SIDE_NAV_HREFS.wallets,
                icon: WalletIcon,
                ...(options.walletFavorites && options.walletFavorites.length > 0
                  ? { children: options.walletFavorites, subnavKey: "wallets" as const }
                  : {}),
              },
            ]
          : []),
      ],
    },
    {
      title: t("Shared.dashboardShell.manage"),
      items: [
        ...(options.issuanceEnabled
          ? [
              {
                label: t("Shared.dashboardShell.issuance"),
                href: DASHBOARD_SIDE_NAV_HREFS.issuance,
                icon: CoinsIcon,
              },
            ]
          : []),
        ...(options.paymentsEnabled
          ? [
              {
                label: t("Shared.dashboardShell.payments"),
                href: DASHBOARD_SIDE_NAV_HREFS.payments,
                icon: ArrowLeftRightIcon,
                children: getPaymentsActions(t, options.canWrite),
                subnavKey: "payments" as const,
              },
            ]
          : []),
        // Markets appears whenever it is on AND at least one sub-module is,
        // rather than requiring Earn specifically — a DvP-only org still needs
        // the entry point.
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
        ...(options.heliusRingsEnabled
          ? [
              {
                label: t("Shared.dashboardShell.heliusRings"),
                href: DASHBOARD_SIDE_NAV_HREFS.heliusRings,
                icon: CircleDotDashedIcon,
              },
            ]
          : []),
        {
          label: t("Shared.dashboardShell.apiKeys"),
          href: DASHBOARD_SIDE_NAV_HREFS.apiKeys,
          icon: KeyRoundIcon,
        },
        {
          label: t("Shared.dashboardShell.integrations"),
          href: DASHBOARD_SIDE_NAV_HREFS.integrations,
          icon: BlocksIcon,
        },
      ],
    },
  ];
}

export const docsHref = resolveDocsUrl();
