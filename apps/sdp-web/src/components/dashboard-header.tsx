"use client";

import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { ArrowDownIcon, ChevronLeftIcon, DownloadIcon, MenuIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ACCOUNT_TABS } from "@/app/(session)/dashboard/[projectId]/account/account-tabs";
import {
  type IntegrationProviderIdentity,
  integrationProviderIdentity,
} from "@/app/(session)/dashboard/[projectId]/integrations/integration-detail";
import { IntegrationProviderMark } from "@/app/(session)/dashboard/[projectId]/integrations/integration-provider-mark";
import { privateChannelsInstancePath } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { SETTINGS_TABS } from "@/app/(session)/dashboard/[projectId]/settings/settings-tabs";
import {
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import type { DashboardHeaderTabsConfig } from "@/components/dashboard-header-tabs";
import { getPaymentsActions } from "@/components/dashboard-nav";
import type { DashboardRouteTabsConfig } from "@/components/dashboard-route-tabs";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import type { DashboardCapabilities } from "@/lib/dashboard-access";
import { dashboardRequest } from "@/lib/dashboard-fetch";
import {
  DASHBOARD_ACCOUNT_HREF,
  DASHBOARD_MARKETS_SUBNAV_HREFS,
} from "@/lib/dashboard-navigation-loading";
import {
  PAYMENT_REQUEST_NEW_HREF,
  PAYMENT_REQUESTS_HREF,
  PAYMENT_TRANSACTIONS_HREF,
} from "@/lib/payments-routes";
import { useProjectHref } from "@/lib/use-dashboard-project";

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
   * Pages set the title and tabs in the page's column; this names that column when it
   * is narrower than the content box, as on a flow whose footer band spans the whole card.
   */
  headerWidthClass?: string;
  /** The page's one primary action, set in the title row (Download CSV, Add, New). */
  headerAction?: DashboardHeaderActionConfig;
  hideTitle?: boolean;
  /**
   * A flow that hides its title and sets its own top spacing: the header keeps its
   * padding only on a phone, where it holds the menu button.
   */
  flushTopOnDesktop?: boolean;
  backAction?: {
    href: string;
    label: string;
  };
  /**
   * Holds the place of the mark a page sets beside its title (a wallet's provider mark) until the
   * page names itself, so the header is its final height from the first frame.
   */
  titleMark?: ReactNode;
  /** One line under a marked title saying what the page's subject is (a provider's purpose). */
  description?: string;
};

export type DashboardHeaderActionConfig = {
  label: string;
  href: string;
  /** Left out for a plain label, as a contact page's Pay is. */
  icon?: "plus" | "download" | "arrow-down";
  variant: "primary" | "outline";
  /** Appends the page's current query string, so an export follows the list's filters. */
  withCurrentQuery?: boolean;
  /**
   * A file download rather than a page: an anchor with `download` whose click fetches the file,
   * so a failed export reaches the user as a message rather than a broken download.
   */
  download?: boolean;
  /** Hidden from a viewer without this capability, whose click would only reach a refusal. */
  capability?: keyof DashboardCapabilities;
};

// The header's action is 34px from md, 2px under the shared small button; on a phone,
// where it sits alone under the title, the design draws it 38px with 16px sides.
const HEADER_ACTION_SIZE_CLASS =
  "[--button-height-md:2.125rem] max-md:[--button-height-md:2.375rem] max-md:[--button-padding-x-md:1rem]";

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
      className={HEADER_ACTION_SIZE_CLASS}
      loading={pending}
      onClick={() => void download()}
      iconLeft={<DownloadIcon className="size-4" aria-hidden="true" />}
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
  const Icon =
    action.icon === undefined
      ? null
      : action.icon === "plus"
        ? PlusIcon
        : action.icon === "arrow-down"
          ? ArrowDownIcon
          : DownloadIcon;
  const target = action.withCurrentQuery && search ? `${action.href}?${search}` : action.href;
  if (action.download) {
    // The export route is an API path, not a dashboard page, so it takes no project segment.
    return (
      <DashboardHeaderDownloadAction href={target} label={action.label} variant={action.variant} />
    );
  }
  const href = projectHref(target);
  return (
    <Button
      asChild
      variant={action.variant === "primary" ? "default" : "outline"}
      size="sm"
      className={HEADER_ACTION_SIZE_CLASS}
    >
      <Link href={href}>
        {Icon === null ? null : <Icon className="size-4" aria-hidden="true" />}
        {action.label}
      </Link>
    </Button>
  );
}

type DashboardTopBarProps = {
  setMobileSidebarOpen: (value: boolean) => void;
  titleVisibility: "visible" | "desktop-only" | "screen-reader-only";
  title: string;
  titlePosition?: "left" | "center";
  topBarLeadingContent?: ReactNode;
  hasHeaderTabs?: boolean;
  action?: ReactNode;
  /** Set over a left title: an action page's way back. */
  above?: ReactNode;
  /** Page-level controls at the title row's end (Payments puts its demo switch here). */
  utilities?: ReactNode;
  /** Shown before the page's title, as a wallet's provider mark is. */
  mark?: ReactNode;
  /** Set under a marked title. */
  description?: string;
  /** Set after the title on its line (a record's status). */
  badge?: ReactNode;
};

export function HeaderBackAction({
  href,
  label,
  compactOnMobile = false,
  locked = false,
}: {
  href: string;
  label: string;
  compactOnMobile?: boolean;
  /** Shown but not followable, while the page holds work that leaving would drop. */
  locked?: boolean;
}) {
  const projectHref = useProjectHref();
  const content = (
    <>
      <ChevronLeftIcon className="size-4 block" />
      <span
        className={[
          "text-body leading-5 font-normal",
          compactOnMobile ? "hidden sm:inline" : "",
        ].join(" ")}
      >
        {label}
      </span>
    </>
  );
  // The chevron's stroke sits on the column's edge (the 16px icon has 6px of air before it), 6px to its label.
  const className =
    "inline-flex items-center rounded-[var(--button-radius-md)] -ml-1.5 h-5 gap-1.5";
  if (locked) {
    return (
      <button type="button" disabled className={cn(className, "cursor-not-allowed text-tertiary")}>
        {content}
      </button>
    );
  }
  return (
    <Link
      href={projectHref(href)}
      className={cn(className, "text-secondary transition-colors hover:text-primary")}
    >
      {content}
    </Link>
  );
}

/**
 * The phone header's way into the navigation: the design's 20px menu glyph on a 36px
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
 * The title block. On a phone it is the design's three rows: the navigation button, the
 * title 8px under it, then the page's action 16px under that. From md the button goes and the
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
  mark,
  description,
  badge,
}: {
  navigation: ReactNode;
  title: string;
  action?: ReactNode;
  trailingContent: ReactNode;
  hideTitle?: boolean;
  /** Set over the title in its column: an action page's way back. */
  above?: ReactNode;
  /** Set before the title, 16px from it (a wallet's 48px provider mark). */
  mark?: ReactNode;
  /** Set under the title beside the mark. */
  description?: string;
  /** Set after the title on its line. */
  badge?: ReactNode;
}) {
  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-x-0"
      data-dashboard-stacked-topbar
    >
      <div className="col-start-1 row-start-1 flex items-center md:hidden">{navigation}</div>
      {/* On a phone the way back shares the navigation button's row, its chevron 4px from the
          button; from md it sits over the title. */}
      {above && !hideTitle ? (
        <div className="col-start-2 row-start-1 -ml-1 flex min-w-0 items-center md:hidden">
          {above}
        </div>
      ) : null}
      {hideTitle ? (
        <h1 className="sr-only">{title}</h1>
      ) : (
        <div className="col-span-3 row-start-2 min-w-0 md:col-span-1 md:col-start-1 md:row-start-1">
          {/* The back link's row: the design's 32px top row with the link centred, 2px over the
              title. A flex row, so the link's 20px line sets the height, not the strut. */}
          {above ? (
            <div className={cn("flex items-center max-md:hidden", mark ? "mb-4" : "h-8 mb-0.5")}>
              {above}
            </div>
          ) : null}
          {mark ? (
            <div className="flex min-w-0 items-center gap-4">
              {/* A flex box, so an inline mark sits on no line box and the row is the mark's height. */}
              <span className="flex shrink-0">{mark}</span>
              <div className="min-w-0">
                <h1 className="min-w-0 max-w-full break-words text-page-title font-medium text-primary">
                  {title}
                </h1>
                {description ? (
                  <p className="mt-1 text-body text-secondary">{description}</p>
                ) : null}
              </div>
            </div>
          ) : badge ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="min-w-0 max-w-full break-words text-page-title font-medium text-primary">
                {title}
              </h1>
              {badge}
            </div>
          ) : (
            <h1 className="min-w-0 max-w-full break-words text-page-title font-medium text-primary">
              {title}
            </h1>
          )}
        </div>
      )}
      {/* An empty state whose action repeats this one (New, Add) hides it: the shell's
          section is the `page` group and the state carries the attribute. Under a back link
          the design sets the action on the title's row (a contact's Pay, a token's Explorer),
          not centred beside the back link and the title together; `data-align-title` asks for
          the same without one. */}
      {action ? (
        <div
          className={cn(
            "col-span-3 row-start-3 mt-2 flex items-center justify-start group-has-[[data-hides-page-action]]/page:hidden md:col-span-1 md:col-start-3 md:row-start-1 md:mt-0 md:ml-3 md:has-[[data-align-title]]:self-end",
            above && "md:self-end"
          )}
        >
          {action}
        </div>
      ) : null}
      {trailingContent ? (
        // On a phone it shares the navigation button's row; from md it sits on the title's row
        // before the action. The md columns have no gap, only margins, so a missing or hidden
        // action leaves no empty gap at the right edge. Under a back link it keeps to the title's
        // row as the action does, in a 36px box like the action's, so the two share a centre.
        <div
          className={cn(
            "col-start-3 row-start-1 flex items-center justify-end empty:hidden md:col-start-2 md:ml-3",
            above && "md:h-9 md:self-end"
          )}
        >
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
  /** Set over the title in its column: an action page's way back. */
  above?: ReactNode;
}) {
  return (
    // The row is exactly the title's height, so the 24px to the tabs is measured from
    // the title itself and a taller page action centres on it.
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] xl:grid-cols-[0_minmax(0,1fr)_auto] xl:gap-x-0 min-h-0 items-center"
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
  setMobileSidebarOpen,
  titleVisibility,
  title,
  titlePosition,
  topBarLeadingContent,
  hasHeaderTabs = false,
  action,
  above,
  utilities,
  mark,
  description,
  badge,
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
  const openNavigation = () => setMobileSidebarOpen(true);

  if (!centersPageTitle && !topBarLeadingContent) {
    return (
      <StackedDashboardTopBar
        navigation={<MobileNavButton onClick={openNavigation} />}
        title={title}
        hideTitle={titleVisibility === "screen-reader-only"}
        above={above}
        mark={mark}
        description={description}
        badge={badge}
        action={action}
        trailingContent={utilityContent}
      />
    );
  }

  // A phone needs the menu button beside a centred, back-linked or base title.
  const sidebarToggle = <MobileNavButton onClick={openNavigation} />;

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
 * A payments flow (Pay, Deposit): the title sits left above the flow's own tabs,
 * both in the flow's column, and the content box stays full width so the flow's footer band
 * can span the card. No back action: the footer's Cancel returns to Payments. A flow with one
 * way in has no tabs.
 */
function refreshFlowPageConfig(config: {
  title: string;
  tabs?: DashboardHeaderTabsConfig["tabs"];
}): DashboardPageConfig {
  const pageConfig: DashboardPageConfig = {
    title: config.title,
    titlePosition: "left",
    contentWidthClass: "max-w-none",
    headerWidthClass: "max-w-flow",
  };
  if (config.tabs) {
    pageConfig.headerTabs = { tabs: config.tabs, hideOnMobile: false };
  }
  return pageConfig;
}

/** Width of the overview and list pages: the design's 900px column. */
const PAGE_WIDTH = "max-w-page";

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

/** The Privacy connect form: a left title over the form's column. */
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
    // A flow: the way back over the title in the form's column; the footer band spans
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
      contentWidthClass: PAGE_WIDTH,
      backAction: {
        href: "/dashboard/payments/counterparty",
        label: t("Shared.dashboardShell.contactList"),
      },
      headerAction: {
        label: t("Shared.dashboardShell.pay"),
        capability: "canWrite",
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
      titlePosition: "left",
      contentWidthClass: PAGE_WIDTH,
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
  if (pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.treasurySolutions) {
    return {
      title: t("Shared.dashboardShell.treasurySolutions"),
      titlePosition: "left",
      contentWidthClass: PAGE_WIDTH,
    };
  }
  if (pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram) {
    return {
      title: t("Shared.dashboardShell.earnProgram"),
      titlePosition: "left",
      contentWidthClass: PAGE_WIDTH,
      headerAction: {
        label: t("DashboardMarkets.earnProgram.configureShort"),
        href: `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/configure`,
        variant: "primary",
      },
    };
  }
  // The integration guide: the way back to the portfolio over a left title.
  if (pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/configure`) {
    return {
      title: t("DashboardMarkets.earnProgram.configureShort"),
      contentWidthClass: PAGE_WIDTH,
      backAction: {
        href: DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram,
        label: t("Shared.dashboardShell.earnProgram"),
      },
    };
  }
  if (pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.dvp) {
    return {
      title: t("Shared.dashboardShell.markets"),
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    };
  }
  return null;
}

function getWalletRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>,
  paymentsEnabled: boolean
): DashboardPageConfig | null {
  const walletDetailMatch = pathname.match(/^\/dashboard\/wallets\/([^/]+)\/?$/);
  const isWalletDetail = walletDetailMatch !== null && walletDetailMatch[1] !== "setup";
  if (!isWalletDetail) return null;

  // The wallet names itself (and sets its provider mark and star) through DashboardPageTitle;
  // "Wallet" and a mark-sized block hold the place until it does.
  return {
    title: t("Shared.dashboardShell.wallet"),
    titleMark: <SkeletonBlock className="size-12 rounded-full" />,
    contentWidthClass: PAGE_WIDTH,
    backAction: {
      href: "/dashboard/wallets",
      label: t("Shared.dashboardShell.wallets"),
    },
    headerTabs: {
      tabs: [
        { id: "overview", label: t("Shared.tabs.overview") },
        { id: "activity", label: t("Shared.tabs.activity") },
        { id: "settings", label: t("Shared.tabs.settings") },
      ],
      hideOnMobile: false,
    },
    headerAction: paymentsEnabled
      ? {
          label: t("Shared.dashboardShell.deposit"),
          href: "/dashboard/payments/deposit",
          icon: "arrow-down",
          variant: "primary",
        }
      : undefined,
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
  return null;
}

/** Issuance: the list, the draft flow and one token's page. */
function getIssuanceRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard/issuance") {
    return {
      title: t("Shared.dashboardShell.issuance"),
      // The design keeps Overview and API Playground on a phone too.
      headerTabs: { ...playgroundHeaderTabs(t), hideOnMobile: false },
      contentWidthClass: PAGE_WIDTH,
      headerAction: {
        label: t("DashboardIssuance.newDesign.createDraft"),
        href: "/dashboard/issuance/create",
        icon: "plus",
        variant: "primary",
        capability: "canManageTokenWrite",
      },
    };
  }
  // The flow names itself in its step header; the footer's Exit is the way back.
  if (pathname === "/dashboard/issuance/create") {
    return {
      title: t("DashboardIssuance.newDesign.draft.pageTitle"),
      hideTitle: true,
      flushTopOnDesktop: true,
      contentWidthClass: "max-w-none",
      headerWidthClass: "max-w-flow",
    };
  }
  if (!/^\/dashboard\/issuance\/[^/]+\/?$/.test(pathname)) {
    return null;
  }
  // The token names itself through DashboardPageTitle; "Token" holds the place until it does.
  return {
    title: t("DashboardIssuance.newDesign.token.pageTitle"),
    contentWidthClass: PAGE_WIDTH,
    backAction: {
      href: "/dashboard/issuance",
      label: t("Shared.dashboardShell.issuance"),
    },
    headerTabs: {
      tabs: [
        { id: "overview", label: t("Shared.tabs.overview") },
        { id: "details", label: t("DashboardIssuance.newDesign.tabs.details") },
        { id: "public", label: t("DashboardIssuance.newDesign.tabs.public") },
        { id: "compliance", label: t("DashboardIssuance.newDesign.tabs.compliance") },
        { id: "operations", label: t("DashboardIssuance.newDesign.tabs.operations") },
        { id: "permissions", label: t("DashboardIssuance.newDesign.tabs.permissions") },
        { id: "activity", label: t("Shared.tabs.activity") },
      ],
      hideOnMobile: false,
    },
  };
}

const INTEGRATION_FAMILY_TITLE_KEYS = {
  custody: "Shared.integrations.custodyTitle",
  ramps: "Shared.integrations.rampsTitle",
  compliance: "Shared.integrations.complianceTitle",
} as const satisfies Record<IntegrationProviderIdentity["family"], MessageKey>;

function getIntegrationsPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  const providerPageId = /^\/dashboard\/integrations\/([^/]+)$/.exec(pathname)?.[1];
  if (providerPageId) {
    const identity = integrationProviderIdentity(providerPageId);
    if (!identity) {
      return {
        title: t("Shared.dashboardShell.integrations"),
        contentWidthClass: PAGE_WIDTH,
        backAction: {
          href: "/dashboard/integrations",
          label: t("Shared.integrations.backToIntegrations"),
        },
      };
    }
    // The provider names itself in the header from the static catalog, so the mark and the
    // line under the title are there from the first frame.
    return {
      title: identity.label,
      titleMark: <IntegrationProviderMark identity={identity} />,
      description: t(identity.descriptionKey),
      contentWidthClass: PAGE_WIDTH,
      backAction: {
        href: "/dashboard/integrations",
        label: t(INTEGRATION_FAMILY_TITLE_KEYS[identity.family]),
      },
    };
  }
  // A new connection: a flow, so the way back over the title in the form's column and the
  // footer band across the page. Checked before the connection route, which `new` also matches.
  const newConnectionProvider = /^\/dashboard\/integrations\/([^/]+)\/connections\/new$/.exec(
    pathname
  )?.[1];
  if (newConnectionProvider) {
    const providerName = isKnownCustodyProvider(newConnectionProvider)
      ? formatCustodyProviderName(newConnectionProvider)
      : newConnectionProvider;
    return {
      title: t("DashboardCustody.newConnectionTitle", { provider: providerName }),
      contentWidthClass: "max-w-none",
      headerWidthClass: "max-w-flow",
      backAction: {
        href: `/dashboard/integrations/${newConnectionProvider}`,
        label: providerName,
      },
    };
  }
  // One custody connection. Checked before the catch-all below, which would
  // otherwise title this "Integrations" and send Back to the catalogue rather
  // than to the provider that owns the connection.
  const provider = /^\/dashboard\/integrations\/([^/]+)\/connections\/[^/]+$/.exec(pathname)?.[1];
  if (provider) {
    return {
      title: t("DashboardCustody.connectionPageTitle"),
      contentWidthClass: PAGE_WIDTH,
      backAction: {
        href: `/dashboard/integrations/${provider}`,
        label: isKnownCustodyProvider(provider) ? formatCustodyProviderName(provider) : provider,
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
 * Header config for the wallet section's landing routes. Returns null elsewhere.
 */
function getWalletSectionPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  // The list and the create flow: a left title over the
  // design's 900px column with the page's one action beside it.
  if (pathname === "/dashboard/wallets") {
    return {
      title: t("Shared.dashboardShell.wallets"),
      headerTabs: playgroundHeaderTabs(t),
      contentWidthClass: PAGE_WIDTH,
      headerAction: {
        label: t("Shared.dashboardShell.createAWallet"),
        href: "/dashboard/wallets/setup",
        icon: "plus",
        variant: "primary",
        capability: "canManageCustody",
      },
    };
  }
  // The flow names itself in its step header, as the design draws it; the title stays for
  // assistive tech and the footer's Cancel is the way back.
  if (pathname === "/dashboard/wallets/setup") {
    return {
      title: t("Shared.dashboardShell.createWallet"),
      hideTitle: true,
      contentWidthClass: "max-w-none",
      headerWidthClass: "max-w-flow",
    };
  }
  return null;
}

/**
 * Header config for the Payments pages: the overview, the three
 * lists and the two flows. Returns null for every other route.
 */
function getPaymentsPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>,
  rampsEnabled: boolean
): DashboardPageConfig | null {
  if (pathname === "/dashboard/payments/counterparty") {
    return {
      title: t("Shared.dashboardShell.contactList"),
      titlePosition: "left",
      contentWidthClass: PAGE_WIDTH,
      headerAction: {
        label: t("DashboardPayments.counterparty.add"),
        capability: "canWrite",
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
      contentWidthClass: PAGE_WIDTH,
    };
  }
  if (pathname === "/dashboard/payments/transactions") {
    return {
      title: t("Shared.dashboardShell.transactions"),
      titlePosition: "left",
      contentWidthClass: PAGE_WIDTH,
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
      contentWidthClass: PAGE_WIDTH,
      headerAction: {
        label: t("DashboardPayments.requests.new"),
        capability: "canWrite",
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
      contentWidthClass: PAGE_WIDTH,
      backAction: { href: PAYMENT_REQUESTS_HREF, label: t("Shared.dashboardShell.requests") },
    };
  }
  if (pathname.startsWith(`${PAYMENT_TRANSACTIONS_HREF}/`)) {
    // The page titles itself with what moved and between whom; "Transaction" holds the place
    // until it does.
    return {
      title: t("Shared.dashboardShell.transaction"),
      contentWidthClass: PAGE_WIDTH,
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
      contentWidthClass: PAGE_WIDTH,
      headerAction: {
        label: t("DashboardPayments.recurring.new"),
        capability: "canWrite",
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
    // A provider deposit is an on-ramp, so without Ramps the address is the only way in.
    return refreshFlowPageConfig({
      title: t("Shared.dashboardShell.deposit"),
      tabs: rampsEnabled
        ? [
            { id: "address", label: t("DashboardPayments.depositMethod.address") },
            {
              id: "provider",
              label: t("DashboardPayments.depositMethod.provider"),
              capability: "canWrite",
            },
          ]
        : undefined,
    });
  }
  return null;
}

// The first page and the holdings page reached from it.
function getHomePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard") {
    return {
      title: t("Shared.dashboardShell.newDesign.home"),
      titlePosition: "left",
      contentWidthClass: PAGE_WIDTH,
    };
  }
  if (pathname === "/dashboard/tokens") {
    // Reached from the Overview's holdings, so it carries a way back rather than
    // relying on the sidebar, which does not list it.
    return {
      title: t("Shared.dashboardShell.holdings"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard",
        label: t("Shared.dashboardShell.newDesign.backToHome"),
      },
    };
  }
  return null;
}

/**
 * The header for a dashboard route. `rampsEnabled` is whether the deployment's channel runs
 * Ramps; unknown counts as not, so a module the API refuses never shows.
 */
export function getDashboardPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>,
  paymentsEnabled = true,
  rampsEnabled = false
): DashboardPageConfig {
  const accessControlPageConfig = getAccessControlPageConfig(pathname, t);
  if (accessControlPageConfig) return accessControlPageConfig;
  const homePageConfig = getHomePageConfig(pathname, t);
  if (homePageConfig) return homePageConfig;
  const walletSectionPageConfig = getWalletSectionPageConfig(pathname, t);
  if (walletSectionPageConfig) return walletSectionPageConfig;
  const walletRoutePageConfig = getWalletRoutePageConfig(pathname, t, paymentsEnabled);
  if (walletRoutePageConfig) return walletRoutePageConfig;
  const issuanceRoutePageConfig = getIssuanceRoutePageConfig(pathname, t);
  if (issuanceRoutePageConfig) return issuanceRoutePageConfig;
  const paymentsConfig = getPaymentsPageConfig(pathname, t, rampsEnabled);
  if (paymentsConfig) {
    return paymentsConfig;
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
      contentWidthClass: PAGE_WIDTH,
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
    const action = getPaymentsActions(t, true).find((item) => pathname.startsWith(item.href));
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
  if (pathname.startsWith("/dashboard/settings")) {
    return {
      title: t("Shared.organizationSettings.title"),
      contentWidthClass: PAGE_WIDTH,
      headerTabs: {
        tabs: SETTINGS_TABS.map((tab) => ({
          id: tab.id,
          label: t(tab.labelKey),
          capability: "capability" in tab ? tab.capability : undefined,
        })),
        hideOnMobile: false,
      },
    };
  }
  if (pathname === DASHBOARD_ACCOUNT_HREF) {
    return {
      title: t("Shared.account.title"),
      contentWidthClass: PAGE_WIDTH,
      headerTabs: {
        tabs: ACCOUNT_TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey) })),
        hideOnMobile: false,
      },
    };
  }
  if (pathname.startsWith("/dashboard/allowlist")) {
    return { title: t("Shared.dashboardShell.allowlist") };
  }
  return { title: t("Shared.dashboardShell.newDesign.home") };
}
