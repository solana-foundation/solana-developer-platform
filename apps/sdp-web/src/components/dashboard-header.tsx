"use client";

import { UserButton } from "@clerk/nextjs";
import { ArrowLeftIcon, PanelRightIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { DashboardHeaderTabsConfig } from "@/components/dashboard-header-tabs";
import { getPaymentsActions } from "@/components/dashboard-nav";
import { LanguagePicker } from "@/components/language-picker";
import { NotificationBell } from "@/components/notification-bell";
import { Badge } from "@/components/ui/badge";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { cn } from "@/lib/utils";

type DashboardPageConfig = {
  title: string;
  /**
   * Where the visible title renders: "center" puts it in the top bar row,
   * "left" above the content in the header-tab layout. Defaults by condition —
   * header-tab pages sit left, everything else centers.
   */
  titlePosition?: "left" | "center";
  headerTabs?: DashboardHeaderTabsConfig;
  topBarLeadingContent?: ReactNode;
  contentWidthClass?: string;
  hideTitle?: boolean;
  backAction?: {
    href: string;
    label: string;
  };
};

type DashboardTopBarProps = {
  isMobileSidebarOpen: boolean;
  setMobileSidebarOpen: (value: boolean) => void;
  hideTitle?: boolean;
  title: string;
  titlePosition?: "left" | "center";
  topBarLeadingContent?: ReactNode;
  hasHeaderTabs?: boolean;
  // Notifications ship with the asset-profiles feature (its only producer today).
  showNotifications?: boolean;
};

export function HeaderBackAction({
  href,
  label,
  compactOnMobile = false,
}: {
  href: string;
  label: string;
  compactOnMobile?: boolean;
}) {
  return (
    <Link
      href={href}
      className="inline-flex h-7 items-center gap-1.5 rounded-[var(--button-radius-md)] text-secondary transition-colors hover:text-primary"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      <span
        className={[
          "text-[13px] leading-[18px] font-medium",
          compactOnMobile ? "hidden sm:inline" : "",
        ].join(" ")}
      >
        {label}
      </span>
    </Link>
  );
}

function SidebarToggle({
  isMobileSidebarOpen,
  setMobileSidebarOpen,
}: {
  isMobileSidebarOpen: boolean;
  setMobileSidebarOpen: (value: boolean) => void;
}) {
  const t = useTranslations();
  return (
    <button
      type="button"
      aria-label={t("Shared.dashboardShell.openNavigation")}
      onClick={() => setMobileSidebarOpen(true)}
      // Hidden below xl: the bottom bar and its More sheet own mobile navigation,
      // and two entry points to the same destinations is worse than one. Kept for
      // the narrow window between the sidebar collapsing and xl, where neither the
      // persistent sidebar nor the bottom bar is present.
      className={[
        "hidden h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-fill-strong",
        isMobileSidebarOpen ? "invisible" : "",
      ].join(" ")}
    >
      <PanelRightIcon className="h-4 w-4" />
    </button>
  );
}

export function CenteredDashboardTopBar({
  leadingContent,
  title,
  trailingContent,
}: {
  leadingContent: ReactNode;
  title: string;
  trailingContent: ReactNode;
}) {
  return (
    <div
      className="grid min-h-[40px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[1fr_auto_1fr]"
      data-dashboard-centered-topbar
    >
      <div className="flex min-w-0 items-center gap-3">{leadingContent}</div>
      <div className="col-span-2 row-start-2 flex min-w-0 items-center justify-center sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <h1 className="min-w-0 max-w-full text-center text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-primary">
          {title}
        </h1>
      </div>
      <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 sm:col-start-3">
        {trailingContent}
      </div>
    </div>
  );
}

export function StandardDashboardTopBar({
  leadingContent,
  title,
  trailingContent,
  hideTitle = false,
  alignTitleWithTabs = false,
}: {
  leadingContent: ReactNode;
  title: string;
  trailingContent: ReactNode;
  hideTitle?: boolean;
  alignTitleWithTabs?: boolean;
}) {
  return (
    <div
      className="grid min-h-[40px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] xl:grid-cols-[0_minmax(0,1fr)_auto] xl:gap-x-0"
      data-dashboard-standard-topbar
    >
      <div className="col-start-1 row-start-1 flex min-w-0 items-center">{leadingContent}</div>
      {/* Hiding the title is a visual decision, not a structural one — every page
          still needs exactly one h1 for assistive tech and for tests that look one
          up by name. */}
      {hideTitle ? (
        <h1 className="sr-only">{title}</h1>
      ) : (
        <h1
          className={cn(
            "col-span-2 row-start-2 min-w-0 max-w-full break-words text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-primary sm:col-span-1 sm:col-start-2 sm:row-start-1",
            alignTitleWithTabs && "xl:pl-[var(--tab-padding-x-md)]"
          )}
        >
          {title}
        </h1>
      )}
      <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 sm:col-start-3 xl:ml-3">
        {trailingContent}
      </div>
    </div>
  );
}

export function DashboardTopBar({
  isMobileSidebarOpen,
  setMobileSidebarOpen,
  hideTitle,
  title,
  titlePosition,
  topBarLeadingContent,
  hasHeaderTabs = false,
  showNotifications = false,
}: DashboardTopBarProps) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const isSandbox = sdpEnvironment === "sandbox";
  const sandboxBadge = isSandbox ? (
    <>
      <span aria-hidden="true" className="hidden h-4 w-px bg-fill-strong sm:block" />
      <Badge className="hidden sm:inline-flex">{t("Shared.dashboardShell.sandbox")}</Badge>
    </>
  ) : null;
  const centersPageTitle =
    !hideTitle && (titlePosition === undefined ? !hasHeaderTabs : titlePosition === "center");
  const trailingContent = (
    <>
      <LanguagePicker />
      {showNotifications ? <NotificationBell /> : null}
      <UserButton />
      {sandboxBadge}
    </>
  );

  if (centersPageTitle) {
    return (
      <CenteredDashboardTopBar
        title={title}
        leadingContent={
          <>
            <SidebarToggle
              isMobileSidebarOpen={isMobileSidebarOpen}
              setMobileSidebarOpen={setMobileSidebarOpen}
            />
            {topBarLeadingContent}
          </>
        }
        trailingContent={trailingContent}
      />
    );
  }

  return (
    <StandardDashboardTopBar
      hideTitle={hideTitle}
      title={title}
      alignTitleWithTabs={hasHeaderTabs}
      leadingContent={
        <>
          <SidebarToggle
            isMobileSidebarOpen={isMobileSidebarOpen}
            setMobileSidebarOpen={setMobileSidebarOpen}
          />
          {topBarLeadingContent}
        </>
      }
      trailingContent={trailingContent}
    />
  );
}

function playgroundHeaderTabs(t: ReturnType<typeof useTranslations>): DashboardHeaderTabsConfig {
  return {
    tabs: [
      { id: "overview", label: t("Shared.tabs.overview") },
      { id: "playground", label: t("Shared.tabs.apiPlayground") },
    ],
    hideOnMobile: true,
  };
}

function actionPageConfig(config: {
  title: string;
  backHref: string;
  backLabel: string;
  contentWidthClass: string;
}): DashboardPageConfig {
  return {
    title: config.title,
    titlePosition: "center",
    topBarLeadingContent: (
      <HeaderBackAction href={config.backHref} label={config.backLabel} compactOnMobile />
    ),
    contentWidthClass: config.contentWidthClass,
  };
}

/** Title for a Private Channels sub-view, from its route segment. */
function privateChannelsSubPageTitle(
  t: ReturnType<typeof useTranslations>,
  segment: string
): string {
  switch (segment) {
    case "setup":
      return t("DashboardPrivateChannels.tabs.instance");
    case "channels":
      return t("DashboardPrivateChannels.tabs.channels");
    case "deposit":
      return t("DashboardPrivateChannels.tabs.deposit");
    case "transfer":
      return t("DashboardPrivateChannels.tabs.transfer");
    case "withdraw":
      return t("DashboardPrivateChannels.tabs.withdraw");
    case "members":
      return t("DashboardPrivateChannels.tabs.members");
    case "wallets":
      return t("DashboardPrivateChannels.overview.walletsTitle");
    case "events":
      return t("DashboardPrivateChannels.tabs.events");
    default:
      return t("Shared.dashboardShell.privateChannels");
  }
}

/**
 * Header config for the Private Channels segment. The Overview hub is a plain
 * section title; every other view is entered from the Overview and so carries a
 * "Back to private channels" action. Returns null for non-PC routes.
 */
function getPrivateChannelsRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (!pathname.startsWith("/dashboard/integrations/private-channels")) {
    return null;
  }
  if (pathname === "/dashboard/integrations/private-channels") {
    return {
      title: t("Shared.dashboardShell.integrations"),
      contentWidthClass: "max-w-5xl",
      backAction: {
        href: "/dashboard/integrations",
        label: t("Shared.integrations.backToIntegrations"),
      },
    };
  }
  if (pathname === "/dashboard/integrations/private-channels/setup") {
    return actionPageConfig({
      title: t("DashboardPrivateChannels.instance.title"),
      backHref: "/dashboard/integrations/private-channels",
      backLabel: t("Shared.dashboardShell.backToPrivateChannels"),
      contentWidthClass: "max-w-5xl",
    });
  }
  const isHub = pathname.startsWith("/dashboard/integrations/private-channels/overview");
  if (isHub) {
    return {
      title: t("Shared.dashboardShell.privateChannels"),
      contentWidthClass: "max-w-none",
    };
  }
  // The segment layout draws the Private Channels tab strip — and its bottom
  // rule — directly under the top bar. `backAction` would add the top bar's own
  // divider above it and double the rule, so the back link rides as plain
  // leading content instead, the same way header-tab pages suppress that border.
  return {
    title: privateChannelsSubPageTitle(t, pathname.split("/")[4] ?? ""),
    contentWidthClass: "max-w-none",
    topBarLeadingContent: (
      <HeaderBackAction
        href="/dashboard/integrations/private-channels/overview"
        label={t("Shared.dashboardShell.backToPrivateChannels")}
        compactOnMobile
      />
    ),
  };
}

function getCounterpartyRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard/payments/counterparty/create") {
    return actionPageConfig({
      title: t("Shared.dashboardShell.newCounterparty"),
      backHref: "/dashboard/payments/counterparty",
      backLabel: t("Shared.dashboardShell.backToCounterparty"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname.startsWith("/dashboard/payments/counterparty/")) {
    return {
      title: t("Shared.dashboardShell.manageCounterparty"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/payments/counterparty",
        label: t("Shared.dashboardShell.backToCounterparty"),
      },
    };
  }
  return null;
}

function getMarketsRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard/markets") {
    return {
      title: t("Shared.dashboardShell.markets"),
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/markets/treasury-solutions") {
    return {
      title: t("Shared.dashboardShell.treasurySolutions"),
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram) {
    return {
      title: t("Shared.dashboardShell.earnProgram"),
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    };
  }
  if (
    pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/configure` ||
    pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/button-builder`
  ) {
    return {
      title: t("Shared.dashboardShell.configureEarnButton"),
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    };
  }
  return null;
}

function getWalletRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  const walletPolicyRouteMatch = pathname.match(
    /^\/dashboard\/(wallets|custody)\/([^/]+)\/policy(?:\/|$)/
  );
  if (walletPolicyRouteMatch) {
    const [, section, walletId] = walletPolicyRouteMatch;
    const isPolicyEvaluationDetail = /\/policy\/audit\/[^/]+$/.test(pathname);
    return actionPageConfig({
      title: t("Shared.dashboardShell.walletControls"),
      backHref: isPolicyEvaluationDetail
        ? `/dashboard/${section}/${walletId}/policy/audit`
        : `/dashboard/${section}/${walletId}`,
      backLabel: isPolicyEvaluationDetail
        ? t("Shared.dashboardShell.backToPolicyHistory")
        : t("Shared.dashboardShell.backToWallet"),
      contentWidthClass: "max-w-none",
    });
  }

  const isWalletDetail =
    (pathname.startsWith("/dashboard/wallets/") && pathname !== "/dashboard/wallets/setup") ||
    (pathname.startsWith("/dashboard/custody/") && pathname !== "/dashboard/custody/setup");
  if (!isWalletDetail) return null;

  return {
    title: t("Shared.dashboardShell.wallets"),
    contentWidthClass: "max-w-none",
    backAction: {
      href: "/dashboard/wallets",
      label: t("Shared.dashboardShell.backToWallets"),
    },
  };
}

function getAccessControlPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard/api-keys") {
    return {
      title: t("Shared.dashboardShell.apiKeys"),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/api-keys/new") {
    return actionPageConfig({
      title: t("Shared.dashboardShell.newApiKey"),
      backHref: "/dashboard/api-keys",
      backLabel: t("Shared.dashboardShell.backToApiKeys"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname.startsWith("/dashboard/api-keys/") && pathname.endsWith("/edit")) {
    return actionPageConfig({
      title: t("Shared.dashboardShell.editApiKey"),
      backHref: "/dashboard/api-keys",
      backLabel: t("Shared.dashboardShell.backToApiKeys"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname === "/dashboard/approvals") {
    return {
      title: t("Shared.dashboardShell.approvals"),
      headerTabs: {
        tabs: [
          { id: "pending", label: t("DashboardApprovals.pendingTab") },
          { id: "history", label: t("DashboardApprovals.historyTab") },
        ],
        hideOnMobile: false,
      },
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname.startsWith("/dashboard/approvals")) {
    return {
      title: t("Shared.dashboardShell.approvals"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/approvals",
        label: t("Shared.dashboardShell.backToApprovals"),
      },
    };
  }

  return null;
}

function getIssuanceRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>,
  assetProfilesEnabled: boolean
): DashboardPageConfig | null {
  if (pathname === "/dashboard/issuance") {
    return {
      title: t("Shared.dashboardShell.issuance"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/issuance/create") {
    return actionPageConfig({
      title: t("Shared.dashboardShell.newAsset"),
      backHref: "/dashboard/issuance",
      backLabel: t("Shared.dashboardShell.backToOverview"),
      contentWidthClass: "max-w-none",
    });
  }
  if (!pathname.startsWith("/dashboard/issuance/")) {
    return null;
  }
  // Gate the chrome on the same flag the page uses to pick the workspace. Flag
  // on → the create flow's centered title + capped column; off → the legacy
  // left-aligned, full-width layout, untouched.
  if (assetProfilesEnabled) {
    return actionPageConfig({
      title: t("Shared.dashboardShell.assetManagement"),
      backHref: "/dashboard/issuance",
      backLabel: t("Shared.dashboardShell.backToOverview"),
      contentWidthClass: "max-w-7xl",
    });
  }
  return {
    title: t("Shared.dashboardShell.issuance"),
    contentWidthClass: "max-w-none",
    backAction: {
      href: "/dashboard/issuance",
      label: t("Shared.dashboardShell.backToOverview"),
    },
  };
}

function getIntegrationsPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (/^\/dashboard\/integrations\/[^/]+$/.test(pathname)) {
    return {
      title: t("Shared.dashboardShell.integrations"),
      contentWidthClass: "max-w-5xl",
      backAction: {
        href: "/dashboard/integrations",
        label: t("Shared.integrations.backToIntegrations"),
      },
    };
  }
  if (pathname.startsWith("/dashboard/integrations")) {
    // Card-grid page: fill the shell's wide container instead of stacking a
    // second max-width inside the centered default and stranding gutters.
    return {
      title: t("Shared.dashboardShell.integrations"),
      // The family axis rides the header tabs like policies; the catalog keeps
      // status and search as its own secondary filters.
      headerTabs: {
        tabs: [
          { id: "all", label: t("Shared.integrations.filterAllFamilies") },
          { id: "custody", label: t("Shared.integrations.custodyTitle") },
          { id: "rpc", label: t("Shared.integrations.rpcTitle") },
          { id: "ramps", label: t("Shared.integrations.rampsTitle") },
          { id: "compliance", label: t("Shared.integrations.complianceTitle") },
          { id: "privacy", label: t("Shared.integrations.privacyTitle") },
        ],
        hideOnMobile: false,
      },
      contentWidthClass: "max-w-7xl",
    };
  }
  return null;
}

/**
 * Header config for the wallet section's landing routes, under both the
 * `/wallets` and legacy `/custody` prefixes. Returns null elsewhere.
 */
function getWalletSectionPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard/wallets" || pathname === "/dashboard/custody") {
    return {
      title: t("Shared.dashboardShell.wallets"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/wallets/setup" || pathname === "/dashboard/custody/setup") {
    return {
      title: t("Shared.dashboardShell.createWallet"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/wallets",
        label: t("Shared.dashboardShell.backToWallets"),
      },
    };
  }
  if (
    pathname === "/dashboard/wallets/connections" ||
    pathname === "/dashboard/custody/connections"
  ) {
    return {
      title: t("Shared.dashboardShell.connections"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/wallets",
        label: t("Shared.dashboardShell.backToWallets"),
      },
    };
  }
  if (pathname === "/dashboard/wallets/switch" || pathname === "/dashboard/custody/switch") {
    return {
      title: t("Shared.dashboardShell.activateProvider"),
      contentWidthClass: "max-w-3xl",
      backAction: {
        href: "/dashboard/wallets",
        label: t("Shared.dashboardShell.backToWallets"),
      },
    };
  }
  return null;
}

export function getDashboardPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>,
  assetProfilesEnabled: boolean,
  privateChannelsEnabled: boolean
): DashboardPageConfig {
  const accessControlPageConfig = getAccessControlPageConfig(pathname, t);
  if (accessControlPageConfig) return accessControlPageConfig;
  if (pathname === "/dashboard") {
    // Home names itself: the sidebar marks it active and the page opens on a
    // balance. A 36px "Home" above that spent a slice of the viewport saying
    // nothing, so the workspace renders an sr-only heading instead.
    return {
      title: t("Shared.dashboardShell.home"),
      hideTitle: true,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/tokens") {
    // Reached from the home allocation card, so it carries a way back rather than
    // relying on the sidebar, which does not list it.
    return {
      title: t("Shared.dashboardShell.holdings"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard",
        label: t("Shared.dashboardShell.backToHome"),
      },
    };
  }
  const walletSectionPageConfig = getWalletSectionPageConfig(pathname, t);
  if (walletSectionPageConfig) return walletSectionPageConfig;
  const walletRoutePageConfig = getWalletRoutePageConfig(pathname, t);
  if (walletRoutePageConfig) return walletRoutePageConfig;
  if (pathname === "/dashboard/policies") {
    return {
      title: t("Shared.dashboardShell.policies"),
      headerTabs: {
        tabs: [
          { id: "all", label: t("DashboardPolicies.all") },
          { id: "wallets", label: t("DashboardPolicies.wallets") },
          { id: "api_keys", label: t("DashboardPolicies.apiKeys") },
        ],
        hideOnMobile: false,
      },
      contentWidthClass: "max-w-none",
    };
  }
  const issuanceRoutePageConfig = getIssuanceRoutePageConfig(pathname, t, assetProfilesEnabled);
  if (issuanceRoutePageConfig) return issuanceRoutePageConfig;
  if (pathname === "/dashboard/payments/counterparty") {
    return {
      title: t("Shared.dashboardShell.counterparty"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: "max-w-none",
    };
  }
  const counterpartyRouteConfig = getCounterpartyRoutePageConfig(pathname, t);
  if (counterpartyRouteConfig) {
    return counterpartyRouteConfig;
  }
  const marketsRouteConfig = getMarketsRoutePageConfig(pathname, t);
  if (marketsRouteConfig) {
    return marketsRouteConfig;
  }
  if (pathname === "/dashboard/payments") {
    return {
      title: t("Shared.dashboardShell.payments"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/payments/transactions") {
    return {
      title: t("Shared.dashboardShell.transactions"),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/payments/requests") {
    return {
      title: t("Shared.dashboardShell.requests"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/payments/recurring") {
    return {
      title: t("Shared.dashboardShell.recurringPayments"),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/payments/recurring/create") {
    return actionPageConfig({
      title: t("Shared.dashboardShell.recurringPayment"),
      backHref: "/dashboard/payments/recurring",
      backLabel: t("Shared.dashboardShell.backToRecurringPayments"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname.startsWith("/dashboard/payments/recurring/")) {
    return {
      title: t("Shared.dashboardShell.recurringPayment"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/payments/recurring",
        label: t("Shared.dashboardShell.backToRecurringPayments"),
      },
    };
  }
  const privateChannelsConfig = getPrivateChannelsRoutePageConfig(pathname, t);
  if (privateChannelsConfig) {
    return privateChannelsConfig;
  }
  if (pathname.startsWith("/dashboard/payments/")) {
    const action = getPaymentsActions(t, privateChannelsEnabled).find((item) =>
      pathname.startsWith(item.href)
    );
    const title = action
      ? action.label
      : pathname.endsWith("/receive")
        ? t("Shared.dashboardShell.receive")
        : t("Shared.dashboardShell.send");

    return actionPageConfig({
      title,
      backHref: "/dashboard/payments",
      backLabel: t("Shared.dashboardShell.backToPayments"),
      contentWidthClass: "max-w-none",
    });
  }
  const integrationsConfig = getIntegrationsPageConfig(pathname, t);
  if (integrationsConfig) {
    return integrationsConfig;
  }
  if (pathname.startsWith("/dashboard/settings")) {
    // Settings was the only route left on the `max-w-5xl` default, which stranded a
    // wide empty gutter beside its cards. Widened rather than set to `max-w-none`:
    // the members table and the RPC form are label/value rows, and letting them span
    // an ultrawide display pushes each value far from its label.
    return {
      title: t("Shared.dashboardShell.settings"),
      contentWidthClass: "max-w-7xl",
    };
  }
  if (pathname.startsWith("/dashboard/allowlist")) {
    return { title: t("Shared.dashboardShell.allowlist") };
  }
  return { title: t("Shared.dashboardShell.home") };
}
