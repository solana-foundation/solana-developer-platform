"use client";

import type { UnifiedTransactionModule } from "@sdp/types";
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  DownloadIcon,
  Loader2Icon,
  MenuIcon,
  PanelRightIcon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/dashboard/[projectId]/custody/provider-catalog";
import { privateChannelsInstancePath } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import type { DashboardHeaderTabsConfig } from "@/components/dashboard-header-tabs";
import { getPaymentsActions } from "@/components/dashboard-nav";
import type { DashboardRouteTabsConfig } from "@/components/dashboard-route-tabs";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { dashboardRequest } from "@/lib/dashboard-fetch";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { type DesignModuleFlags, isNewDesignPage } from "@/lib/design-modules";
import {
  PAYMENT_REQUEST_NEW_HREF,
  PAYMENT_REQUESTS_HREF,
  PAYMENT_TRANSACTIONS_HREF,
} from "@/lib/payments-routes";
import { useProjectHref } from "@/lib/use-dashboard-project";
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
  /** Left out for a plain label, as a contact page's Pay is. */
  icon?: "plus" | "download";
  variant: "primary" | "outline";
  /** Appends the page's current query string, so an export follows the list's filters. */
  withCurrentQuery?: boolean;
  /**
   * A file download rather than a page: an anchor with `download` whose click fetches the file,
   * so a failed export reaches the user as a message rather than a broken download.
   */
  download?: boolean;
};

/** The saved file's name, off a Content-Disposition header. */
function attachmentFilename(header: string | null): string | null {
  return header?.match(/filename="([^"]+)"/)?.[1] ?? null;
}

/**
 * A download action. The click fetches the file and saves it, the button spinning meanwhile (an
 * export can wait out the API's rate limit), and a failure shows as a toast. It is a button, not
 * a link: the page never navigates to the file.
 */
function DashboardHeaderDownloadAction({
  href,
  label,
  variant,
}: {
  href: string;
  label: string;
  variant: DashboardHeaderActionConfig["variant"];
}) {
  const t = useTranslations();
  const [pending, setPending] = useState(false);

  const download = async () => {
    setPending(true);
    try {
      const response = await dashboardRequest(href, { method: "GET" });
      if (!response.ok) {
        toast.error(
          t(
            response.status === 429
              ? "Shared.dashboardShell.downloadRateLimited"
              : "Shared.dashboardShell.downloadFailed"
          )
        );
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = attachmentFilename(response.headers.get("Content-Disposition")) ?? "";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      toast.error(t("Shared.dashboardShell.downloadFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    // The icon goes in the button's icon slot: as a child it would sit on its own line above the
    // label, since the shared button wraps children in their own box.
    <Button
      type="button"
      variant={variant === "primary" ? "default" : "outline"}
      size="sm"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() => void download()}
      iconLeft={
        pending ? (
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <DownloadIcon className="size-4" aria-hidden="true" />
        )
      }
    >
      {label}
    </Button>
  );
}

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
  const projectHref = useProjectHref();
  const Icon = action.icon === undefined ? null : action.icon === "plus" ? PlusIcon : DownloadIcon;
  const target = action.withCurrentQuery && search ? `${action.href}?${search}` : action.href;
  if (action.download) {
    // The export route is an API path, not a dashboard page, so it takes no project segment.
    return (
      <DashboardHeaderDownloadAction href={target} label={action.label} variant={action.variant} />
    );
  }
  const href = projectHref(target);
  return (
    <Button asChild variant={action.variant === "primary" ? "default" : "outline"} size="sm">
      <Link href={href}>
        {Icon === null ? null : <Icon className="size-4" aria-hidden="true" />}
        {action.label}
      </Link>
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
  /**
   * Whether the phone's bottom bar is on screen (the previous design). Without it a base layout
   * still needs the menu button, in its title row's leading slot.
   */
  hasBottomNav?: boolean;
  /** Page-level controls at the title row's end (Payments puts its demo switch here). */
  utilities?: ReactNode;
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
  const projectHref = useProjectHref();
  return (
    <Link
      href={projectHref(href)}
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
 * The refresh title block. On a phone it is the design's three rows: the navigation button, the
 * title 8px under it, then the page's action 12px under that. From md the button goes and the
 * action sits on the title's row. Any utilities (Payments' demo mode switch) sit at the far right
 * of the phone's navigation row, and from md on the title's row, before the action.
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
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-x-0"
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
        <div className="col-span-3 row-start-3 mt-1 flex items-center justify-start group-has-[[data-hides-page-action]]/page:hidden md:col-span-1 md:col-start-3 md:row-start-1 md:mt-0 md:ml-3">
          {action}
        </div>
      ) : null}
      {trailingContent ? (
        // On a phone it shares the navigation button's row; from md it sits on the title's row
        // before the action. The md columns have no gap, only margins, so a missing or hidden
        // action leaves no empty gap at the right edge.
        <div className="col-start-3 row-start-1 flex items-center justify-end empty:hidden md:col-start-2 md:ml-3">
          {trailingContent}
        </div>
      ) : null}
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
  hasBottomNav = true,
  utilities,
}: DashboardTopBarProps) {
  const utilityContent = utilities ?? null;
  const trailingContent = action ? (
    <>
      {action}
      {utilityContent}
    </>
  ) : (
    utilityContent
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
        trailingContent={utilityContent}
      />
    );
  }

  // A phone with no bottom bar (any refresh route, and every route on NEW DESIGN) needs the menu
  // button beside a centred, back-linked or base title; the previous design's toggle stays
  // hidden behind the bar.
  const showsMenuButton = isRefresh || !hasBottomNav;
  const sidebarToggle = showsMenuButton ? (
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
      title: t("Shared.dashboardShell.newDesign.newCounterparty"),
      contentWidthClass: "max-w-none",
      headerWidthClass: "max-w-flow",
      backAction: {
        href: "/dashboard/payments/counterparty",
        label: t("Shared.dashboardShell.contactList"),
      },
    };
  }
  if (pathname.startsWith("/dashboard/payments/counterparty/")) {
    // A detail page reads in the page column; at full width it would lose the shell's gutter.
    // The page titles itself with the contact's name; "Contact" holds the place until it does.
    const counterpartyId = pathname.split("/")[4] ?? "";
    return {
      title: t("Shared.dashboardShell.contact"),
      contentWidthClass: REFRESH_PAGE_WIDTH,
      backAction: {
        href: "/dashboard/payments/counterparty",
        label: t("Shared.dashboardShell.contactList"),
      },
      headerAction: {
        label: t("Shared.dashboardShell.pay"),
        href: `/dashboard/payments/pay?counterpartyId=${encodeURIComponent(counterpartyId)}`,
        variant: "primary",
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
  if (pathname === PAYMENT_REQUESTS_HREF) {
    return {
      title: t("Shared.dashboardShell.requests"),
      titlePosition: "left",
      contentWidthClass: REFRESH_PAGE_WIDTH,
      headerAction: {
        label: t("DashboardPayments.requests.new"),
        href: PAYMENT_REQUEST_NEW_HREF,
        icon: "plus",
        variant: "primary",
      },
    };
  }
  if (pathname === PAYMENT_REQUEST_NEW_HREF) {
    return {
      title: t("DashboardPayments.requests.newRequest"),
      contentWidthClass: "max-w-none",
      headerWidthClass: "max-w-flow",
      backAction: { href: PAYMENT_REQUESTS_HREF, label: t("Shared.dashboardShell.requests") },
    };
  }
  if (pathname.startsWith(`${PAYMENT_REQUESTS_HREF}/`)) {
    // A request's page reads in the page column, the way back over its title.
    return {
      title: t("DashboardPayments.requests.paymentRequest"),
      contentWidthClass: REFRESH_PAGE_WIDTH,
      backAction: { href: PAYMENT_REQUESTS_HREF, label: t("Shared.dashboardShell.requests") },
    };
  }
  if (pathname.startsWith(`${PAYMENT_TRANSACTIONS_HREF}/`)) {
    // The page titles itself with what moved and between whom; "Transaction" holds the place
    // until it does.
    return {
      title: t("Shared.dashboardShell.transaction"),
      contentWidthClass: REFRESH_PAGE_WIDTH,
      backAction: {
        href: PAYMENT_TRANSACTIONS_HREF,
        label: t("Shared.dashboardShell.transactions"),
      },
    };
  }
  if (pathname === "/dashboard/payments/recurring") {
    return {
      title: t("Shared.dashboardShell.newDesign.recurringPayments"),
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

/**
 * Header config for the routes NEW DESIGN redesigns, as the previous design draws them: Payments
 * and the Privacy connect form. Returns null for every other route, and for the new design's own
 * routes, which send the previous design back to their list.
 */
function getLegacyDesignPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>,
  privateChannelsEnabled: boolean,
  transactionModules: readonly UnifiedTransactionModule[]
): DashboardPageConfig | null {
  if (pathname === "/dashboard/integrations/private-channels/setup") {
    return actionPageConfig({
      title: t("DashboardPrivateChannels.instance.title"),
      backHref: "/dashboard/integrations/private-channels",
      backLabel: t("Shared.dashboardShell.backToPrivateChannels"),
      contentWidthClass: "max-w-none",
    });
  }
  const privateChannelsSetup = pathname.match(
    /^\/dashboard\/integrations\/private-channels\/([^/]+)\/setup$/
  );
  if (privateChannelsSetup) {
    return actionPageConfig({
      title: t("DashboardPrivateChannels.instance.title"),
      backHref: privateChannelsInstancePath(privateChannelsSetup[1]),
      backLabel: t("Shared.dashboardShell.backToPrivateChannels"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname !== "/dashboard/payments" && !pathname.startsWith("/dashboard/payments/")) {
    return null;
  }
  if (pathname === "/dashboard/payments/counterparty") {
    return {
      title: t("Shared.dashboardShell.counterparty"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: "max-w-none",
    };
  }
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
  if (pathname === "/dashboard/payments") {
    return {
      title: t("Shared.dashboardShell.payments"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: "max-w-none",
    };
  }
  if (
    pathname === PAYMENT_TRANSACTIONS_HREF ||
    pathname.startsWith(`${PAYMENT_TRANSACTIONS_HREF}/`)
  ) {
    return {
      title: t("Shared.dashboardShell.transactions"),
      headerTabs: {
        tabs: [
          { id: "all", label: t("DashboardPayments.transactions.all") },
          ...transactionModules.map((module) => ({
            id: module,
            label: t(`DashboardPayments.transactions.modules.${module}` as MessageKey),
          })),
        ],
        hideOnMobile: false,
      },
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === PAYMENT_REQUESTS_HREF || pathname.startsWith(`${PAYMENT_REQUESTS_HREF}/`)) {
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
  const action = getPaymentsActions(t, privateChannelsEnabled, { newDesign: false }).find((item) =>
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

export function getDashboardPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>,
  assetProfilesEnabled: boolean,
  privateChannelsEnabled: boolean,
  // Transactions tabs, from `enabledTransactionModules`.
  transactionModules: readonly UnifiedTransactionModule[],
  custodyEnabled = true,
  _paymentsEnabled = true,
  _policiesEnabled = true,
  newDesign = true,
  newDesignModules?: DesignModuleFlags
): DashboardPageConfig {
  // This page's design: NEW DESIGN and, for a redesigned area, its module's flag too.
  const newDesignPage = isNewDesignPage(pathname, { newDesign, newDesignModules });
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
  // A Payments page no design module has redesigned keeps the previous design's header under
  // NEW DESIGN too.
  const legacyDesignConfig = !newDesignPage
    ? getLegacyDesignPageConfig(pathname, t, privateChannelsEnabled, transactionModules)
    : null;
  if (legacyDesignConfig) {
    return legacyDesignConfig;
  }
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
        label: t("Shared.dashboardShell.newDesign.backToRecurringPayments"),
      },
    };
  }
  if (pathname.startsWith("/dashboard/payments/recurring/")) {
    return {
      title: t("Shared.dashboardShell.newDesign.recurringPayment"),
      contentWidthClass: REFRESH_PAGE_WIDTH,
      backAction: {
        href: "/dashboard/payments/recurring",
        label: t("Shared.dashboardShell.newDesign.backToRecurringPayments"),
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
    // the members table rows are label/value pairs, and letting them span
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
