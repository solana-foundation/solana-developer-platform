"use client";

import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  DownloadIcon,
  MenuIcon,
  PanelRightIcon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { privateChannelsInstancePath } from "@/app/dashboard/integrations/private-channels/private-channels-routes";
import type { DashboardHeaderTabsConfig } from "@/components/dashboard-header-tabs";
import { getPaymentsActions } from "@/components/dashboard-nav";
import type { DashboardRouteTabsConfig } from "@/components/dashboard-route-tabs";
import { LanguagePicker } from "@/components/language-picker";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { PAYMENT_REQUEST_CREATE_PARAM } from "@/lib/payments-routes";
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
  routeTabs?: DashboardRouteTabsConfig;
  topBarLeadingContent?: ReactNode;
  contentWidthClass?: string;
  /**
   * Refresh pages set the title and tabs in the page's column; this names that column when it
   * is narrower than the content box, as on a flow whose footer band spans the whole card.
   */
  headerWidthClass?: string;
  /** The page's one primary action, set in the title row (Download CSV, Add, New). */
  headerAction?: DashboardHeaderActionConfig;
  hideTitle?: boolean;
  hideTitleOnMobile?: boolean;
  backAction?: {
    href: string;
    label: string;
  };
};

export type DashboardHeaderActionConfig = {
  label: string;
  href: string;
  icon: "plus" | "download";
  variant: "primary" | "outline";
  /** Appends the page's current query string, so an export follows the list's filters. */
  withCurrentQuery?: boolean;
  /** A file download rather than a page: rendered as a plain anchor with `download`. */
  download?: boolean;
};

const TRAILING_CONTENT = <LanguagePicker />;

/**
 * The title row's page action.
 *
 * @param props - The action config and the page's current query string.
 * @returns The action button.
 */
export function DashboardHeaderAction({
  action,
  search,
}: {
  action: DashboardHeaderActionConfig;
  search: string;
}) {
  const Icon = action.icon === "plus" ? PlusIcon : DownloadIcon;
  const href = action.withCurrentQuery && search ? `${action.href}?${search}` : action.href;
  const content = (
    <>
      <Icon className="size-4" aria-hidden="true" />
      {action.label}
    </>
  );
  return (
    <Button asChild variant={action.variant === "primary" ? "default" : "outline"} size="sm">
      {action.download ? (
        <a href={href} download>
          {content}
        </a>
      ) : (
        <Link href={href}>{content}</Link>
      )}
    </Button>
  );
}

type DashboardTopBarProps = {
  isMobileSidebarOpen: boolean;
  setMobileSidebarOpen: (value: boolean) => void;
  titleVisibility: "visible" | "desktop-only" | "screen-reader-only";
  title: string;
  titlePosition?: "left" | "center";
  topBarLeadingContent?: ReactNode;
  hasHeaderTabs?: boolean;
  action?: ReactNode;
  /** Set over a left title: a refresh action page's way back. */
  above?: ReactNode;
  /**
   * "refresh" is the design's phone header: a menu button that opens the navigation, the title
   * under it, then the page's action; from md the sidebar is back and the action rejoins the
   * title's row. "base" keeps the bottom bar's layout.
   */
  layout?: "base" | "refresh";
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
      className="inline-flex h-7 items-center gap-1.5 rounded-[var(--button-radius-md)] text-secondary transition-colors hover:text-primary refresh:h-5 refresh:gap-1"
    >
      <ArrowLeftIcon className="h-4 w-4 refresh:hidden" />
      <ChevronLeftIcon className="hidden size-4 refresh:block" />
      <span
        className={[
          "text-[13px] leading-[18px] font-medium refresh:text-body refresh:leading-5 refresh:font-normal",
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

/**
 * The refresh phone header's way into the navigation: the design's 20px menu glyph on a 36px
 * target, pulled 4px into the gutter so the glyph's lines start where the title does. Gone
 * from md, where the sidebar itself is on screen.
 */
function MobileNavButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations();
  return (
    <button
      type="button"
      aria-label={t("Shared.dashboardShell.openNavigation")}
      onClick={onClick}
      className="-ml-1 inline-flex size-9 items-center justify-center rounded-control text-secondary transition-colors hover:bg-fill-subtle hover:text-primary md:hidden"
    >
      <MenuIcon className="size-5" strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

/**
 * The refresh title block. On a phone it is the design's three rows: the navigation button
 * (with the language picker at the far right), the title 8px under it, then the page's action
 * 12px under that. From md the button goes and the action and picker sit on the title's row.
 */
export function StackedDashboardTopBar({
  navigation,
  title,
  action,
  trailingContent,
  hideTitle = false,
  above,
}: {
  navigation: ReactNode;
  title: string;
  action?: ReactNode;
  trailingContent: ReactNode;
  hideTitle?: boolean;
  /** Set over the title in its column: a refresh action page's way back. */
  above?: ReactNode;
}) {
  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 md:grid-cols-[minmax(0,1fr)_auto_auto]"
      data-dashboard-stacked-topbar
    >
      <div className="col-start-1 row-start-1 flex items-center md:hidden">{navigation}</div>
      {hideTitle ? (
        <h1 className="sr-only">{title}</h1>
      ) : (
        <div className="col-span-3 row-start-2 min-w-0 md:col-span-1 md:col-start-1 md:row-start-1">
          {above ? <div className="mb-2">{above}</div> : null}
          <h1 className="min-w-0 max-w-full break-words text-page-title font-medium text-primary">
            {title}
          </h1>
        </div>
      )}
      {/* An empty state whose action repeats this one (New, Add) hides it: the shell's
          section is the `page` group and the state carries the attribute. */}
      {action ? (
        <div className="col-span-3 row-start-3 mt-1 flex items-center justify-start group-has-[[data-hides-page-action]]/page:hidden md:col-span-1 md:col-start-2 md:row-start-1 md:mt-0 md:ml-1">
          {action}
        </div>
      ) : null}
      <div className="col-start-3 row-start-1 flex items-center justify-end">{trailingContent}</div>
    </div>
  );
}

export function CenteredDashboardTopBar({
  leadingContent,
  title,
  trailingContent,
  hideTitleOnMobile = false,
}: {
  leadingContent: ReactNode;
  title: string;
  trailingContent: ReactNode;
  hideTitleOnMobile?: boolean;
}) {
  return (
    <div
      className="grid min-h-[40px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[1fr_auto_1fr]"
      data-dashboard-centered-topbar
    >
      <div className="flex min-w-0 items-center gap-3">{leadingContent}</div>
      <div
        className={cn(
          "col-span-2 row-start-2 flex min-w-0 items-center justify-center sm:col-span-1 sm:col-start-2 sm:row-start-1",
          hideTitleOnMobile && "max-xl:sr-only"
        )}
      >
        <h1 className="min-w-0 max-w-full text-center text-page-title font-medium text-primary">
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
  above,
}: {
  leadingContent: ReactNode;
  title: string;
  trailingContent: ReactNode;
  hideTitle?: boolean;
  alignTitleWithTabs?: boolean;
  /** Set over the title in its column: a refresh action page's way back. */
  above?: ReactNode;
}) {
  return (
    // Refresh: the row is exactly the title's height, so the 24px to the tabs is measured from
    // the title itself and a taller page action centres on it.
    <div
      className="grid min-h-[40px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] xl:grid-cols-[0_minmax(0,1fr)_auto] xl:gap-x-0 refresh:min-h-0 refresh:items-center"
      data-dashboard-standard-topbar
    >
      <div className="col-start-1 row-start-1 flex min-w-0 items-center">{leadingContent}</div>
      {/* Hiding the title is a visual decision, not a structural one — every page
          still needs exactly one h1 for assistive tech and for tests that look one
          up by name. */}
      {hideTitle ? (
        <h1 className="sr-only">{title}</h1>
      ) : (
        <div
          className={cn(
            "col-span-2 row-start-2 min-w-0 max-w-full sm:col-span-1 sm:col-start-2 sm:row-start-1",
            alignTitleWithTabs && "xl:pl-[var(--tab-padding-x-md)]"
          )}
        >
          {above ? <div className="mb-2">{above}</div> : null}
          <h1 className="min-w-0 max-w-full break-words text-page-title font-medium text-primary">
            {title}
          </h1>
        </div>
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
  titleVisibility,
  title,
  titlePosition,
  topBarLeadingContent,
  hasHeaderTabs = false,
  action,
  above,
  layout = "base",
}: DashboardTopBarProps) {
  const trailingContent = action ? (
    <>
      {action}
      {TRAILING_CONTENT}
    </>
  ) : (
    TRAILING_CONTENT
  );
  const centersPageTitle =
    titleVisibility !== "screen-reader-only" &&
    (titlePosition === undefined ? !hasHeaderTabs : titlePosition === "center");
  const isRefresh = layout === "refresh";
  const openNavigation = () => setMobileSidebarOpen(true);

  if (isRefresh && !centersPageTitle && !topBarLeadingContent) {
    return (
      <StackedDashboardTopBar
        navigation={<MobileNavButton onClick={openNavigation} />}
        title={title}
        hideTitle={titleVisibility === "screen-reader-only"}
        above={above}
        action={action}
        trailingContent={TRAILING_CONTENT}
      />
    );
  }

  // The refresh phone has no bottom bar, so a centred or back-linked title still needs the
  // menu button; the base shell's toggle stays hidden behind the bar.
  const sidebarToggle = isRefresh ? (
    <MobileNavButton onClick={openNavigation} />
  ) : (
    <SidebarToggle
      isMobileSidebarOpen={isMobileSidebarOpen}
      setMobileSidebarOpen={setMobileSidebarOpen}
    />
  );

  if (centersPageTitle) {
    return (
      <CenteredDashboardTopBar
        title={title}
        hideTitleOnMobile={titleVisibility === "desktop-only"}
        leadingContent={
          <>
            {sidebarToggle}
            {topBarLeadingContent}
          </>
        }
        trailingContent={trailingContent}
      />
    );
  }

  return (
    <StandardDashboardTopBar
      hideTitle={titleVisibility === "screen-reader-only"}
      title={title}
      alignTitleWithTabs={hasHeaderTabs}
      above={above}
      leadingContent={
        <>
          {sidebarToggle}
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

/**
 * A refresh-design payments flow (Pay, Deposit): the title sits left above the flow's own tabs,
 * both in the flow's column, and the content box stays full width so the flow's footer band
 * can span the card. No back action: the footer's Cancel returns to Payments.
 */
function refreshFlowPageConfig(config: {
  title: string;
  tabs: readonly { id: string; label: string }[];
}): DashboardPageConfig {
  return {
    title: config.title,
    titlePosition: "left",
    headerTabs: { tabs: config.tabs, hideOnMobile: false },
    contentWidthClass: "max-w-none",
    headerWidthClass: "max-w-flow",
  };
}

/** Width of the refresh Payments overview and list pages: the design's 900px column. */
const REFRESH_PAGE_WIDTH = "max-w-page";

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

/** The Privacy connect form, on the refresh design: a left title over the form's column. */
function privacySetupPageConfig(t: ReturnType<typeof useTranslations>): DashboardPageConfig {
  return {
    title: t("Shared.dashboardShell.privacy"),
    titlePosition: "left",
    contentWidthClass: "max-w-none",
    headerWidthClass: "max-w-flow",
  };
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
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/integrations",
        label: t("Shared.integrations.backToIntegrations"),
      },
    };
  }
  if (pathname === "/dashboard/integrations/private-channels/setup") {
    return privacySetupPageConfig(t);
  }
  const privateChannelsSegments = pathname.split("/");
  const instanceId = privateChannelsSegments[4];
  const instanceRoute =
    instanceId && !["overview", "setup", "channels", "members", "wallets"].includes(instanceId);
  const instanceSubpage = privateChannelsSegments[5];
  const instanceNestedPage = privateChannelsSegments[6];
  if (instanceRoute && instanceSubpage === "setup") {
    return privacySetupPageConfig(t);
  }
  if (instanceRoute && instanceSubpage === "channels" && instanceNestedPage === "new") {
    return actionPageConfig({
      title: t("DashboardPrivateChannels.directory.setupChannel"),
      backHref: privateChannelsInstancePath(instanceId),
      backLabel: t("Shared.dashboardShell.backToPrivateChannels"),
      contentWidthClass: "max-w-none",
    });
  }
  if (instanceRoute && instanceSubpage === "channels") {
    return {
      title: t("Shared.dashboardShell.privateChannels"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: privateChannelsInstancePath(instanceId),
        label: t("Shared.dashboardShell.backToPrivateChannels"),
      },
    };
  }
  if (instanceRoute && !instanceSubpage) {
    return {
      title: t("Shared.dashboardShell.privateChannels"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/integrations",
        label: t("Shared.integrations.backToIntegrations"),
      },
    };
  }
  const isHub = pathname.startsWith("/dashboard/integrations/private-channels/overview");
  if (isHub) {
    return {
      title: t("Shared.dashboardShell.privateChannels"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/integrations",
        label: t("Shared.integrations.backToIntegrations"),
      },
    };
  }
  return {
    title: privateChannelsSubPageTitle(t, pathname.split("/")[4] ?? ""),
    contentWidthClass: "max-w-none",
    backAction: {
      href: "/dashboard/integrations/private-channels/overview",
      label: t("Shared.dashboardShell.backToPrivateChannels"),
    },
  };
}

function getCounterpartyRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard/payments/counterparty/create") {
    // A refresh flow: the way back over the title in the form's column; the footer band spans
    // the page.
    return {
      title: t("Shared.dashboardShell.newCounterparty"),
      contentWidthClass: "max-w-none",
      headerWidthClass: "max-w-flow",
      backAction: {
        href: "/dashboard/payments/counterparty",
        label: t("Shared.dashboardShell.contactList"),
      },
    };
  }
  if (pathname.startsWith("/dashboard/payments/counterparty/")) {
    return {
      title: t("Shared.dashboardShell.manageCounterparty"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/payments/counterparty",
        label: t("Shared.dashboardShell.contactList"),
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
  // Create is a detail/action route, so it keeps a centred title and a way back
  // to the list — the only orientation such a route has.
  if (pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/create`) {
    return {
      title: t("DashboardMarkets.dvp.createTitle"),
      titlePosition: "center",
      backAction: {
        href: DASHBOARD_MARKETS_SUBNAV_HREFS.dvp,
        label: t("DashboardMarkets.dvp.navLabel"),
      },
      contentWidthClass: "max-w-none",
    };
  }
  // A trade detail page keeps its own centred title beside a back action: it is
  // the only orientation a detail route has, unlike a top-level list where the
  // title would just repeat the active sidebar item.
  if (new RegExp(`^${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/[^/]+$`).test(pathname)) {
    return {
      title: t("DashboardMarkets.dvp.detailTitle"),
      titlePosition: "center",
      backAction: {
        href: DASHBOARD_MARKETS_SUBNAV_HREFS.dvp,
        label: t("DashboardMarkets.dvp.navLabel"),
      },
      contentWidthClass: "max-w-none",
    };
  }
  if (
    pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.treasurySolutions ||
    pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram ||
    pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.dvp
  ) {
    return {
      title: t("Shared.dashboardShell.markets"),
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    };
  }
  if (
    pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/configure` ||
    pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/integrate`
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
    return {
      ...actionPageConfig({
        title: t("Shared.dashboardShell.assetManagement"),
        backHref: "/dashboard/issuance",
        backLabel: t("Shared.dashboardShell.backToOverview"),
        contentWidthClass: "max-w-7xl",
      }),
      hideTitleOnMobile: true,
    };
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
  // One custody connection. Checked before the catch-all below, which would
  // otherwise title this "Integrations" and send Back to the catalogue rather
  // than to the provider that owns the connection.
  const custodyConnection = /^\/dashboard\/integrations\/([^/]+)\/connections\/[^/]+$/.exec(
    pathname
  );
  if (custodyConnection) {
    const provider = custodyConnection[1] ?? "";
    return {
      title: t("DashboardCustody.connectionPageTitle"),
      contentWidthClass: "max-w-5xl",
      backAction: {
        href: `/dashboard/integrations/${provider}`,
        label: t("DashboardCustody.backToProvider", {
          provider: isKnownCustodyProvider(provider)
            ? formatCustodyProviderName(provider)
            : provider,
        }),
      },
    };
  }
  if (pathname.startsWith("/dashboard/integrations")) {
    // Card-grid page: fill the shell's wide container instead of stacking a
    // second max-width inside the centered default and stranding gutters.
    return {
      title: t("Shared.dashboardShell.integrations"),
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

/**
 * Header config for the Payments pages built on the refresh design: the overview, the three
 * lists and the two flows. Returns null for every other route.
 */
function getRefreshPaymentsPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard/payments/counterparty") {
    return {
      title: t("Shared.dashboardShell.contactList"),
      titlePosition: "left",
      contentWidthClass: REFRESH_PAGE_WIDTH,
      headerAction: {
        label: t("DashboardPayments.counterparty.add"),
        href: "/dashboard/payments/counterparty/create",
        icon: "plus",
        variant: "primary",
      },
    };
  }
  if (pathname === "/dashboard/payments") {
    return {
      title: t("Shared.dashboardShell.payments"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: REFRESH_PAGE_WIDTH,
    };
  }
  if (pathname === "/dashboard/payments/transactions") {
    return {
      title: t("Shared.dashboardShell.transactions"),
      titlePosition: "left",
      contentWidthClass: REFRESH_PAGE_WIDTH,
      headerAction: {
        label: t("DashboardPayments.transactions.downloadCsv"),
        href: "/api/dashboard/payments/transactions/export",
        icon: "download",
        variant: "outline",
        withCurrentQuery: true,
        download: true,
      },
    };
  }
  if (pathname === "/dashboard/payments/requests") {
    return {
      title: t("Shared.dashboardShell.requests"),
      titlePosition: "left",
      contentWidthClass: REFRESH_PAGE_WIDTH,
      headerAction: {
        label: t("DashboardPayments.requests.new"),
        href: `/dashboard/payments/requests?${PAYMENT_REQUEST_CREATE_PARAM}=1`,
        icon: "plus",
        variant: "primary",
      },
    };
  }
  if (pathname === "/dashboard/payments/recurring") {
    return {
      title: t("Shared.dashboardShell.recurringPayments"),
      titlePosition: "left",
      contentWidthClass: REFRESH_PAGE_WIDTH,
      headerAction: {
        label: t("DashboardPayments.recurring.new"),
        href: "/dashboard/payments/recurring/create",
        icon: "plus",
        variant: "primary",
      },
    };
  }
  if (pathname === "/dashboard/payments/pay") {
    return refreshFlowPageConfig({
      title: t("Shared.dashboardShell.pay"),
      tabs: [
        { id: "single", label: t("DashboardPayments.sendMode.single") },
        { id: "batch", label: t("DashboardPayments.sendMode.batch") },
      ],
    });
  }
  if (pathname === "/dashboard/payments/deposit") {
    return refreshFlowPageConfig({
      title: t("Shared.dashboardShell.deposit"),
      tabs: [
        { id: "address", label: t("DashboardPayments.depositMethod.address") },
        { id: "provider", label: t("DashboardPayments.depositMethod.provider") },
      ],
    });
  }
  return null;
}

export function getDashboardPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>,
  assetProfilesEnabled: boolean,
  privateChannelsEnabled: boolean,
  custodyEnabled = true,
  _paymentsEnabled = true,
  _policiesEnabled = true
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
        tabs: custodyEnabled
          ? [
              { id: "all", label: t("DashboardPolicies.all") },
              { id: "wallets", label: t("DashboardPolicies.wallets") },
              { id: "api_keys", label: t("DashboardPolicies.apiKeys") },
            ]
          : [{ id: "api_keys", label: t("DashboardPolicies.apiKeys") }],
        hideOnMobile: false,
      },
      contentWidthClass: "max-w-none",
    };
  }
  const issuanceRoutePageConfig = getIssuanceRoutePageConfig(pathname, t, assetProfilesEnabled);
  if (issuanceRoutePageConfig) return issuanceRoutePageConfig;
  const refreshPaymentsConfig = getRefreshPaymentsPageConfig(pathname, t);
  if (refreshPaymentsConfig) {
    return refreshPaymentsConfig;
  }
  const counterpartyRouteConfig = getCounterpartyRoutePageConfig(pathname, t);
  if (counterpartyRouteConfig) {
    return counterpartyRouteConfig;
  }
  const marketsRouteConfig = getMarketsRoutePageConfig(pathname, t);
  if (marketsRouteConfig) {
    return marketsRouteConfig;
  }
  if (pathname === "/dashboard/payments/recurring/create") {
    return {
      title: t("DashboardPayments.recurring.newSchedule"),
      contentWidthClass: "max-w-none",
      headerWidthClass: "max-w-flow",
      backAction: {
        href: "/dashboard/payments/recurring",
        label: t("Shared.dashboardShell.backToRecurringPayments"),
      },
    };
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

    return {
      title,
      contentWidthClass: "max-w-none",
      headerWidthClass: "max-w-flow",
      backAction: {
        href: "/dashboard/payments",
        label: t("Shared.dashboardShell.backToPayments"),
      },
    };
  }
  const integrationsConfig = getIntegrationsPageConfig(pathname, t);
  if (integrationsConfig) {
    return integrationsConfig;
  }
  if (pathname === "/dashboard/helius-rings") {
    return { title: t("Shared.dashboardShell.heliusRings") };
  }
  // Members only redirects into Settings, so its loading frame carries the Settings title.
  if (pathname.startsWith("/dashboard/settings") || pathname === "/dashboard/members") {
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
