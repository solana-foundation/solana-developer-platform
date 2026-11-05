"use client";

import { useAuth } from "@clerk/nextjs";
import { Badge } from "@sdp/ui/badge";
import { cn } from "@sdp/ui/cn";
import { ChevronDownIcon, ChevronLeftIcon, LockIcon, PanelLeftIcon } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { isKnownCustodyProvider } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import {
  DashboardHeaderAction,
  DashboardTopBar,
  getDashboardPageConfig,
  HeaderBackAction,
} from "@/components/dashboard-header";
import { DashboardHeaderTabs } from "@/components/dashboard-header-tabs";
import { DashboardHeaderTabsTrailingContext } from "@/components/dashboard-header-tabs-trailing-context";
import { DashboardLoadingScreen } from "@/components/dashboard-loading-screen";
import {
  DASHBOARD_SUBNAV_GROUPS,
  type DashboardSubnavKey,
  dashboardSubnavId,
  dashboardSubnavStorageKey,
  getNavSections,
  type NavItem,
  type NavSection,
  type SubNavItem,
  withSubnavOpen,
  withSubnavToggled,
} from "@/components/dashboard-nav";
import { resolvePageLoadingComponent } from "@/components/dashboard-page-loading";
import {
  DashboardPageTitleContext,
  type DashboardPageTitleOverride,
} from "@/components/dashboard-page-title-context";
import { DashboardQuickStart } from "@/components/dashboard-quick-start";
import { DashboardRouteTabs } from "@/components/dashboard-route-tabs";
import { NetworkDebugPanel } from "@/components/network-debug-panel";
import { PaymentsDemoNotice } from "@/components/payments-demo-notice";
import { PaymentsDemoToggle } from "@/components/payments-demo-toggle";
import { SentryUserContext } from "@/components/sentry-user-context";
import { SidebarUserMenu } from "@/components/sidebar-user-menu";
import { useWalletFavorites } from "@/components/use-wallet-favorites";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { DashboardFlags } from "@/flags/dashboard";
import { useTranslations } from "@/i18n/provider";
import { setTabShowsDemo } from "@/lib/dashboard-fetch";
import {
  isDashboardNavItemActive,
  resolveDashboardLoadingRoute,
} from "@/lib/dashboard-navigation-loading";
import {
  useDashboardUrlState,
  useSyncDashboardUrlStateWithRouter,
} from "@/lib/dashboard-url-state";
import { isPaymentsPath } from "@/lib/payments-demo/demo-cookie";
import {
  isPaymentsDemoOn,
  PaymentsDemoProvider,
  type PaymentsDemoState,
} from "@/lib/payments-demo/payments-demo-context";
import { useDashboardPathname, useProjectHref } from "@/lib/use-dashboard-project";
import { subscribeWalletFavoriteAdded } from "@/lib/wallet-favorites";

// The sidebar is the design's: 40px rows touching, 6px corners, a 20px icon then 16px to the
// 15px medium label, an ink wash for the active row and a lighter one on hover, no border. A row
// sets its icon 16px in, so its label lines up with the sub-items' at 60px.
const navItemBase =
  "relative flex h-control-lg w-full items-center gap-4 rounded-control pr-2 pl-4 text-nav font-medium transition-colors";
const navItemActive = "bg-fill-strong text-primary";
const navItemInactive = "text-primary hover:bg-fill";
// Sub-items keep the secondary ink until active; the design indents them under the icon
// column instead of drawing a rail beside them.
const childNavItemBase =
  "relative flex h-control-md flex-1 items-center gap-2.5 rounded-control pr-2 pl-13 text-nav transition-colors";
const childNavItemActive = `${navItemActive} font-medium`;
const childNavItemInactive = "text-secondary hover:bg-fill hover:text-primary";

/**
 * Shown on the row the user clicked until the next page's payload arrives. Always rendered at a
 * fixed size and faded in, so a click never shifts the row.
 */
function NavLinkPendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      data-pending={pending}
      className="pointer-events-none absolute top-1/2 left-1 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity delay-100 data-[pending=true]:opacity-60 motion-reduce:transition-none"
    />
  );
}

/** A sub-item's own leading mark, when it has one. */
function SubNavItemLeading({ item }: { item: SubNavItem }) {
  return item.leading ? (
    <span aria-hidden="true" className="inline-flex shrink-0">
      {item.leading}
    </span>
  ) : null;
}

function SidebarGroup({
  title,
  items,
  pathname,
  onNavigate,
  isCollapsed,
  showTopSeparator,
  openSubnavs,
  onSubnavToggle,
  onSubnavOpen,
  variant,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
  isCollapsed: boolean;
  showTopSeparator: boolean;
  openSubnavs: Record<DashboardSubnavKey, boolean>;
  onSubnavToggle: (key: DashboardSubnavKey) => void;
  /**
   * Open a section without closing it again. Following a top-level item is a
   * request to go there, so it reveals the section's pages; toggling would
   * collapse the submenu of the page being navigated to (HOO-1218).
   */
  onSubnavOpen: (key: DashboardSubnavKey) => void;
  variant: "desktop" | "mobile";
}) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const search = useSearchParams().toString();
  const navigationLocation = search ? `${pathname}?${search}` : pathname;
  return (
    <div className="space-y-2">
      <p
        className={cn(
          "relative px-2 text-meta leading-4",
          isCollapsed ? "text-transparent" : "text-secondary"
        )}
      >
        {title}
        {isCollapsed && showTopSeparator ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-3 left-3 h-px -translate-y-1/2 bg-border-strong"
          />
        ) : null}
      </p>
      <div>
        {items.map((item) => {
          const Icon = item.icon;
          const active = isDashboardNavItemActive(navigationLocation, item.href);
          const subnavKey = item.subnavKey;
          const showChildren = !isCollapsed && item.children && item.children.length > 0;
          const childrenExpanded = subnavKey ? openSubnavs[subnavKey] : true;
          const subnavId = subnavKey ? dashboardSubnavId(subnavKey, variant) : undefined;

          return (
            <div key={item.label}>
              <div className="relative flex items-center">
                <Link
                  href={projectHref(item.href)}
                  onClick={() => {
                    // The chevron still toggles. This only ever opens, so a
                    // second click on the section you are already in does not
                    // hide its pages.
                    if (subnavKey) {
                      onSubnavOpen(subnavKey);
                    }
                    onNavigate?.();
                  }}
                  title={isCollapsed ? item.label : undefined}
                  aria-label={isCollapsed ? item.label : undefined}
                  className={cn(
                    navItemBase,
                    active ? navItemActive : navItemInactive,
                    isCollapsed && "justify-center px-2"
                  )}
                >
                  <Icon className="size-5 shrink-0 text-primary/45" strokeWidth={1.9} />
                  {isCollapsed ? null : <span className="whitespace-nowrap">{item.label}</span>}
                  <NavLinkPendingHint />
                </Link>
                {subnavKey && !isCollapsed ? (
                  <button
                    type="button"
                    aria-expanded={childrenExpanded}
                    aria-controls={subnavId}
                    aria-label={t(
                      childrenExpanded
                        ? "Shared.dashboardShell.collapseSectionMenu"
                        : "Shared.dashboardShell.expandSectionMenu",
                      { section: item.label }
                    )}
                    onClick={() => onSubnavToggle(subnavKey)}
                    className="absolute right-0 inline-flex size-8 items-center justify-center rounded-control text-secondary transition-colors hover:bg-fill-strong hover:text-primary"
                  >
                    <ChevronDownIcon
                      className={cn(
                        "size-4 transition-transform motion-reduce:transition-none",
                        !childrenExpanded && "-rotate-90"
                      )}
                    />
                  </button>
                ) : null}
              </div>
              {showChildren && childrenExpanded ? (
                <div id={subnavId} className="mt-0.5 space-y-1">
                  {(item.children ?? []).map((child) => {
                    const childActive = isDashboardNavItemActive(navigationLocation, child.href);
                    return (
                      <div key={child.href} className="flex">
                        {child.disabled ? (
                          <span
                            className={cn(childNavItemBase, "cursor-not-allowed text-tertiary")}
                          >
                            <SubNavItemLeading item={child} />
                            <span className="min-w-0 truncate">{child.label}</span>
                            <LockIcon className="ml-auto h-3 w-3" />
                          </span>
                        ) : (
                          <Link
                            href={projectHref(child.href)}
                            onClick={onNavigate}
                            className={cn(
                              childNavItemBase,
                              childActive ? childNavItemActive : childNavItemInactive
                            )}
                          >
                            <SubNavItemLeading item={child} />
                            <span className="min-w-0 truncate">{child.label}</span>
                            <NavLinkPendingHint />
                          </Link>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DashboardSidebarContent({
  navSections,
  pathname,
  onNavigate,
  onClose,
  isCollapsed,
  variant,
  showQuickStart,
  onOrganizationSwitchingChange,
  openSubnavs,
  onSubnavToggle,
  onSubnavOpen,
}: {
  navSections: NavSection[];
  pathname: string;
  onNavigate?: () => void;
  onClose: () => void;
  isCollapsed: boolean;
  variant: "desktop" | "mobile";
  showQuickStart: boolean;
  onOrganizationSwitchingChange: (isSwitching: boolean) => void;
  openSubnavs: Record<DashboardSubnavKey, boolean>;
  onSubnavToggle: (key: DashboardSubnavKey) => void;
  onSubnavOpen: (key: DashboardSubnavKey) => void;
}) {
  const t = useTranslations();
  const showMobileClose = variant === "mobile";
  return (
    <>
      {/* An 8px inset, the workspace row 8px under the top inset, and a scrollbar that only
          shows under the pointer, so the rows keep the design's full 264px width. */}
      <div className="sdp-quiet-scroll min-h-0 flex-1 space-y-6 overflow-x-hidden overflow-y-auto overscroll-contain p-2">
        {/* 8px above sets the 32px avatar 20px from the top, as the design does; 20px below
            keeps the group gap at 24 from the avatar's bottom. */}
        <div className="mt-2 mb-5">
          {showMobileClose ? (
            <div className="flex items-center justify-between gap-2">
              <WorkspaceSwitcher
                collapsed={false}
                onOrganizationSwitchingChange={onOrganizationSwitchingChange}
              />
              <button
                type="button"
                aria-label={t("Shared.dashboardShell.closeNavigation")}
                onClick={onClose}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-fill-strong"
              >
                <PanelLeftIcon className="h-5 w-5" />
              </button>
            </div>
          ) : (
            <WorkspaceSwitcher
              collapsed={isCollapsed}
              onOrganizationSwitchingChange={onOrganizationSwitchingChange}
            />
          )}
        </div>
        {navSections.map((section, idx) => (
          <SidebarGroup
            key={section.title}
            title={section.title}
            items={section.items}
            pathname={pathname}
            onNavigate={onNavigate}
            isCollapsed={isCollapsed}
            showTopSeparator={idx > 0}
            openSubnavs={openSubnavs}
            onSubnavToggle={onSubnavToggle}
            onSubnavOpen={onSubnavOpen}
            variant={variant}
          />
        ))}
      </div>
      <div className="shrink-0 space-y-3 px-2 pb-2">
        {showQuickStart ? <DashboardQuickStart collapsed={isCollapsed} /> : null}
        <SidebarUserMenu
          collapsed={isCollapsed}
          // The mobile slide-over is a 288px column, so the popover only has
          // room above the trigger there.
          menuSide={variant === "desktop" ? "right" : "top"}
        />
      </div>
    </>
  );
}

/**
 * What the shell hands its pages: the setter a page names itself through, and the slot at the
 * right end of the header tab row that `DashboardHeaderTabsTrailing` portals into.
 */
function DashboardShellPageContexts({
  setPageTitle,
  headerTabsTrailingSlot,
  children,
}: {
  setPageTitle: (override: DashboardPageTitleOverride | null) => void;
  headerTabsTrailingSlot: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <DashboardPageTitleContext.Provider value={setPageTitle}>
      <DashboardHeaderTabsTrailingContext.Provider value={headerTabsTrailingSlot}>
        {children}
      </DashboardHeaderTabsTrailingContext.Provider>
    </DashboardPageTitleContext.Provider>
  );
}

function clipsDashboardHorizontalOverflow(pathname: string): boolean {
  return (
    pathname === "/dashboard/payments" ||
    pathname === "/dashboard/payments/transactions" ||
    (pathname.startsWith("/dashboard/payments/") &&
      !pathname.startsWith("/dashboard/payments/counterparty"))
  );
}

function usesWorkspaceViewport(pathname: string): boolean {
  const isWalletDetailRoute =
    pathname.startsWith("/dashboard/wallets/") && pathname !== "/dashboard/wallets/setup";
  const isWalletSetupRoute = pathname === "/dashboard/wallets/setup";

  return (
    pathname === "/dashboard/issuance" ||
    pathname === "/dashboard/issuance/create" ||
    /^\/dashboard\/issuance\/[^/]+\/?$/.test(pathname) ||
    pathname === "/dashboard/api-keys" ||
    pathname === "/dashboard/api-keys/new" ||
    (pathname.startsWith("/dashboard/api-keys/") && pathname.endsWith("/edit")) ||
    pathname.startsWith("/dashboard/payments") ||
    pathname.startsWith("/dashboard/markets") ||
    pathname === "/dashboard/wallets" ||
    isWalletSetupRoute ||
    pathname.startsWith("/dashboard/integrations/private-channels") ||
    isWalletDetailRoute
  );
}

const DEMO_OFF: PaymentsDemoState = { demoProjectId: null };

/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing shell orchestration */ /* react-doctor-disable-next-line no-high-complexity-react-function -- this change only supplies Private Channels route configuration */
export function DashboardShell({
  children,
  flags,
  paymentsDemo = DEMO_OFF,
}: {
  children: ReactNode;
  flags: DashboardFlags;
  paymentsDemo?: PaymentsDemoState;
}) {
  const {
    assetProfiles: assetProfilesEnabled,
    compliance: complianceEnabled,
    custody: custodyEnabled,
    dvp: dvpEnabled,
    earn: earnEnabled,
    heliusRings: heliusRingsEnabled,
    issuance: issuanceEnabled,
    markets: marketsEnabled,
    payments: paymentsEnabled,
    privateChannels: privateChannelsEnabled,
    ramps: rampsEnabled,
  } = flags;
  const t = useTranslations();
  const { isSignedIn, orgId } = useAuth();
  const pathname = useDashboardPathname();
  useSyncDashboardUrlStateWithRouter();
  const { dashboardAccess, selectedProjectId, isSidebarOpen, setSidebarOpen, isProjectSwitching } =
    useDashboardWorkspace();
  // Demo data has a flag of its own; absent in older fixtures, it is on.
  const demoAvailable = isPaymentsPath(pathname) && flags.paymentsDemoMode !== false;
  const demoMode =
    flags.paymentsDemoMode !== false && isPaymentsDemoOn(paymentsDemo, selectedProjectId);
  const paymentsDemoOn = demoAvailable && demoMode;
  useEffect(() => {
    setTabShowsDemo(paymentsDemoOn);
    return () => setTabShowsDemo(false);
  }, [paymentsDemoOn]);
  const [isMobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);
  // A page whose title is data (a contact's name) names itself here.
  const [pageTitleOverride, setPageTitleOverride] = useState<DashboardPageTitleOverride | null>(
    null
  );
  // Set once the header tab row's trailing slot mounts, so a page's controls portal into it.
  const [headerTabsTrailingSlot, setHeaderTabsTrailingSlot] = useState<HTMLElement | null>(null);
  const [openSubnavs, setOpenSubnavs] = useState<Record<DashboardSubnavKey, boolean>>(() => {
    const initial = {} as Record<DashboardSubnavKey, boolean>;
    for (const [key, group] of Object.entries(DASHBOARD_SUBNAV_GROUPS)) {
      initial[key as DashboardSubnavKey] =
        group.defaultOpen || pathname.startsWith(group.pathPrefix);
    }
    return initial;
  });
  const subnavHydratedRef = useRef(false);
  const previousPathnameRef = useRef(pathname);
  const loadingRoute = resolveDashboardLoadingRoute(pathname) ?? "home";
  const PageLoadingComponent = resolvePageLoadingComponent(loadingRoute);
  const isWorkspaceSwitching = isProjectSwitching || isOrganizationSwitching;
  // The design's sidebar is 280px (17.5rem) including its rule.
  const sidebarExpandedWidth = 280;
  const sidebarCollapsedWidth = 64;
  const pageConfig = getDashboardPageConfig(pathname, t, paymentsEnabled, rampsEnabled);
  const { favorites: walletFavorites } = useWalletFavorites();
  const walletFavoriteItems: SubNavItem[] = walletFavorites.map((favorite) => ({
    label: favorite.name,
    href: `/dashboard/wallets/${encodeURIComponent(favorite.walletId)}`,
    leading: (
      <WalletProviderMark
        provider={
          favorite.provider && isKnownCustodyProvider(favorite.provider) ? favorite.provider : null
        }
        size="nav"
      />
    ),
  }));
  const navSections = getNavSections(t, {
    complianceEnabled,
    custodyEnabled,
    dvpEnabled,
    earnEnabled,
    heliusRingsEnabled,
    issuanceEnabled,
    marketsEnabled,
    paymentsEnabled,
    privateChannelsEnabled,
    canWrite: dashboardAccess.capabilities.canWrite,
    walletFavorites: walletFavoriteItems,
    rampsEnabled,
  });
  const activeTitleOverride =
    pageTitleOverride !== null && pageTitleOverride.pathname === pathname
      ? pageTitleOverride
      : null;
  const pageTitle = activeTitleOverride?.title ?? pageConfig.title;
  // A page can insist on its title where the route hides it: a missing page has to say so.
  const titleAlwaysVisible = activeTitleOverride?.alwaysVisible === true;
  const contentWidthClass = pageConfig.contentWidthClass ?? "max-w-5xl";
  const headerTabs = pageConfig.headerTabs && {
    ...pageConfig.headerTabs,
    tabs: pageConfig.headerTabs.tabs.filter(
      (tab) => !tab.capability || dashboardAccess.capabilities[tab.capability]
    ),
  };
  const routeTabs = pageConfig.routeTabs;
  const hasHeaderTabs = Boolean(headerTabs || routeTabs);
  // An action page sets its way back over a left title, in the page's column, tabs or not (a
  // wallet's page has both), as the design does.
  const backAction = pageConfig.backAction ? (
    <HeaderBackAction href={pageConfig.backAction.href} label={pageConfig.backAction.label} />
  ) : null;
  const shouldClipHorizontalOverflow = clipsDashboardHorizontalOverflow(pathname);
  const shouldLockViewportScroll = usesWorkspaceViewport(pathname);
  const shouldLockShellViewport = shouldLockViewportScroll || isMobileSidebarOpen;
  // The dashboard's own URL store rather than useSearchParams: list filters update the query
  // shallowly, and an export has to follow them.
  const { searchParams: urlSearchParams } = useDashboardUrlState();
  const routeAction =
    pageConfig.headerAction &&
    (!pageConfig.headerAction.capability ||
      dashboardAccess.capabilities[pageConfig.headerAction.capability]) ? (
      <DashboardHeaderAction action={pageConfig.headerAction} search={urlSearchParams.toString()} />
    ) : null;
  // A read-only member sees why no page offers a write, in the slot a route's action would take.
  const readOnlyBadge = dashboardAccess.capabilities.canWrite ? null : (
    <Badge variant="outline" data-testid="dashboard-read-only-badge">
      {/* The badge wraps its children in one block span, so the icon and label need a row. */}
      <span className="inline-flex items-center gap-1">
        <LockIcon className="size-3" aria-hidden />
        {t("Shared.dashboardShell.readOnly")}
      </span>
    </Badge>
  );
  // A page's own actions (a wallet's star) sit before the route's action, in the same slot.
  const pageActions = activeTitleOverride?.actions;
  const slotItems = [pageActions, routeAction, readOnlyBadge].filter(Boolean);
  const headerAction =
    slotItems.length > 1 ? (
      <span className="flex items-center gap-2">
        {pageActions}
        {routeAction}
        {readOnlyBadge}
      </span>
    ) : (
      (slotItems[0] ?? null)
    );
  // The title, the tabs and the content share one column with one gutter, so all three share a
  // left edge, with no full-bleed rule under the tabs. The column is the design's 900px page
  // column, or the flow's 660px when the page's content box is wider than its header (a flow's
  // footer band spans the whole page).
  const pageColumnClass = pageConfig.headerWidthClass ?? contentWidthClass;
  const pageGutterClass = "px-4 md:px-6";
  // A flow lays out its own gutter and column (its footer band needs the full width), so only
  // pages with a bounded content box take the shell's gutter.
  const contentTakesGutter = contentWidthClass !== "max-w-none";

  useEffect(() => {
    const tabletViewport = window.matchMedia("(min-width: 768px)");
    const closeMobileNavigation = () => {
      if (tabletViewport.matches) {
        setMobileSidebarOpen(false);
      }
    };
    tabletViewport.addEventListener("change", closeMobileNavigation);
    return () => tabletViewport.removeEventListener("change", closeMobileNavigation);
  }, []);

  useEffect(() => {
    setOpenSubnavs((current) => {
      const next = { ...current };
      for (const key of Object.keys(DASHBOARD_SUBNAV_GROUPS) as DashboardSubnavKey[]) {
        const stored = window.localStorage.getItem(dashboardSubnavStorageKey(key));
        if (stored === "true" || stored === "false") {
          next[key] = stored === "true";
        }
      }
      return next;
    });
    subnavHydratedRef.current = true;
  }, []);

  const persistSubnav = (key: DashboardSubnavKey, open: boolean) => {
    if (subnavHydratedRef.current) {
      window.localStorage.setItem(dashboardSubnavStorageKey(key), String(open));
    }
  };

  // Both handlers compute the next state from the rendered value and write to
  // storage outside the setter. React may replay a state updater, so a
  // localStorage write placed inside one runs more than once.
  const toggleSubnav = (key: DashboardSubnavKey) => {
    const next = withSubnavToggled(openSubnavs, key);
    setOpenSubnavs(next);
    persistSubnav(key, next[key]);
  };

  /**
   * Following a top-level item opens its section (HOO-1218). Persisted like a
   * toggle, because a section opened by navigating is still the reader's last
   * expressed preference and should survive a reload.
   */
  const openSubnav = (key: DashboardSubnavKey) => {
    const next = withSubnavOpen(openSubnavs, key);
    if (next === openSubnavs) {
      return;
    }
    setOpenSubnavs(next);
    persistSubnav(key, true);
  };

  // Pinning a wallet promises it is in the sidebar under Wallets, so the group opens even if it
  // was folded. The write sits outside the updater, which React may replay.
  useEffect(
    () =>
      subscribeWalletFavoriteAdded(() => {
        if (subnavHydratedRef.current) {
          window.localStorage.setItem(dashboardSubnavStorageKey("wallets"), "true");
        }
        setOpenSubnavs((current) => withSubnavOpen(current, "wallets"));
      }),
    []
  );

  useEffect(() => {
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      setMobileSidebarOpen(false);
    }
  }, [pathname]);

  // Signed out, the shell holds the loading screen: Clerk navigates a sign-out to sign-in itself,
  // and any other session end refreshes the route, which the proxy redirects to sign-in.
  if (!isSignedIn || !orgId) {
    return (
      <DashboardLoadingScreen pathname={pathname} flags={flags} isSidebarOpen={isSidebarOpen} />
    );
  }

  return (
    <main
      data-sdp-dashboard-shell=""
      // globals.css drops the root's reserved scrollbar track while the shell is locked.
      data-sdp-locked-viewport={shouldLockShellViewport ? "" : undefined}
      aria-busy={isWorkspaceSwitching}
      className={[
        // dvh, not vh: a phone browser's vh is its height with the toolbars hidden, so a vh shell
        // put a locked page's bottom (a flow's footer) under the toolbar while it shows.
        "min-h-dvh bg-[var(--sdp-shell-bg)] p-0 text-primary",
        // clip, not hidden: a hidden box can still be scrolled by the browser (focusing a
        // control below the fold), which shifts the locked page up and leaves a gap under it.
        shouldLockShellViewport ? "h-dvh overflow-clip" : "",
      ].join(" ")}
    >
      <DashboardShellPageContexts
        setPageTitle={setPageTitleOverride}
        headerTabsTrailingSlot={headerTabsTrailingSlot}
      >
        <PaymentsDemoProvider value={paymentsDemoOn}>
          {paymentsDemoOn ? <PaymentsDemoNotice /> : null}
          <SentryUserContext />
          <NetworkDebugPanel />
          <div
            className={[
              "mx-auto grid min-h-dvh w-full max-w-none gap-0",
              shouldLockViewportScroll ? "h-full" : "",
              "md:grid-cols-[auto_1fr]",
            ].join(" ")}
          >
            <aside
              style={{
                width: isSidebarOpen ? sidebarExpandedWidth : sidebarCollapsedWidth,
              }}
              className="relative z-10 hidden border-r border-border-default bg-[var(--sdp-shell-bg)] md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:justify-between"
            >
              <DashboardSidebarContent
                navSections={navSections}
                pathname={pathname}
                onNavigate={undefined}
                onClose={() => setSidebarOpen(false)}
                isCollapsed={!isSidebarOpen}
                variant="desktop"
                showQuickStart={!isWorkspaceSwitching}
                onOrganizationSwitchingChange={setOrganizationSwitching}
                openSubnavs={openSubnavs}
                onSubnavToggle={toggleSubnav}
                onSubnavOpen={openSubnav}
              />
              <button
                type="button"
                onClick={() => setSidebarOpen(!isSidebarOpen)}
                aria-label={
                  isSidebarOpen
                    ? t("Shared.dashboardShell.collapseSidebar")
                    : t("Shared.dashboardShell.expandSidebar")
                }
                className="absolute top-1/2 right-0 z-20 flex size-6 -translate-y-1/2 translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border-default bg-surface-raised text-secondary shadow-sm transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:border-border-strong hover:text-primary"
              >
                <ChevronLeftIcon
                  className={cn(
                    "size-3.5 transition-transform motion-reduce:transition-none",
                    !isSidebarOpen && "rotate-180"
                  )}
                />
              </button>
            </aside>

            {isMobileSidebarOpen ? (
              <div className="fixed inset-0 z-50 flex md:hidden">
                <button
                  type="button"
                  aria-label={t("Shared.dashboardShell.closeNavigationOverlay")}
                  className="absolute inset-0 bg-primary/30"
                  onClick={() => setMobileSidebarOpen(false)}
                />
                <div className="relative z-10 flex h-full w-72 max-w-[85vw] flex-col justify-between border-r border-border-default bg-[var(--sdp-shell-bg)]">
                  <DashboardSidebarContent
                    navSections={navSections}
                    pathname={pathname}
                    onNavigate={() => setMobileSidebarOpen(false)}
                    onClose={() => setMobileSidebarOpen(false)}
                    isCollapsed={false}
                    variant="mobile"
                    showQuickStart={!isWorkspaceSwitching}
                    onOrganizationSwitchingChange={setOrganizationSwitching}
                    openSubnavs={openSubnavs}
                    onSubnavToggle={toggleSubnav}
                    onSubnavOpen={openSubnav}
                  />
                </div>
              </div>
            ) : null}

            {/* The page is flat on every route: no card, no radius; the sidebar's rule
              separates it. The `page` group lets the header react to the content (an empty state
              hiding the header's action). It is also the work area's size container: the scroll
              panel reads its width (`100cqw`) to span it edge to edge. */}
            <section
              className={cn(
                "group/page @container relative min-w-0 bg-surface-raised",
                // The locked layout keeps only the home indicator's inset.
                shouldLockViewportScroll &&
                  "flex min-h-0 flex-col overflow-clip pb-[env(safe-area-inset-bottom)] md:pb-0"
              )}
            >
              {/* One frame per route. Next already remounts the page on a route change, so the
                header and content wrappers were the only nodes kept across it; the header's height
                and column differ from route to route, and a kept frame moved under the new page
                (a layout shift to the browser). Keyed, the browser sees a page replaced. */}
              <div
                key={pathname}
                data-dashboard-page-frame=""
                className={[
                  "min-w-0 w-full",
                  shouldLockViewportScroll ? "flex min-h-0 flex-1 flex-col" : "space-y-6",
                ].join(" ")}
              >
                {/* The gutter sits outside the centred column, so the title's left edge is the
                  content's at every width; 44px above the title row (a 34px button sits on it),
                  40px above a back link's row, and 24px from the title to the tabs are the
                  design's. */}
                <div
                  className={cn(
                    "shrink-0",
                    pageGutterClass,
                    pageConfig.flushTopOnDesktop && !titleAlwaysVisible
                      ? "pt-6 md:pt-0"
                      : backAction
                        ? "pt-6 md:pt-10"
                        : "pt-6 md:pt-11"
                  )}
                >
                  <div className={cn("mx-auto w-full space-y-6", pageColumnClass)}>
                    <div>
                      <DashboardTopBar
                        setMobileSidebarOpen={setMobileSidebarOpen}
                        titleVisibility={
                          pageConfig.hideTitle && !titleAlwaysVisible
                            ? "screen-reader-only"
                            : "visible"
                        }
                        title={pageTitle}
                        titlePosition={backAction ? "left" : pageConfig.titlePosition}
                        topBarLeadingContent={pageConfig.topBarLeadingContent}
                        hasHeaderTabs={hasHeaderTabs}
                        action={headerAction}
                        above={backAction}
                        mark={activeTitleOverride ? activeTitleOverride.mark : pageConfig.titleMark}
                        utilities={
                          demoAvailable ? <PaymentsDemoToggle {...paymentsDemo} /> : undefined
                        }
                      />
                    </div>

                    {headerTabs ? (
                      <div className="flex items-end gap-4">
                        <div className="sdp-quiet-scroll flex min-w-0 items-end overflow-x-auto">
                          <DashboardHeaderTabs {...headerTabs} />
                        </div>
                        {/* A page's own controls for the tab row (DashboardHeaderTabsTrailing). */}
                        <div
                          ref={setHeaderTabsTrailingSlot}
                          className="ml-auto flex shrink-0 items-center gap-4 self-center empty:hidden"
                        />
                      </div>
                    ) : null}

                    {routeTabs ? (
                      <div
                        className={cn(
                          "border-b border-border-default",
                          !shouldLockViewportScroll && "-mx-3 md:-mx-6"
                        )}
                      >
                        <div className="flex items-end px-3 md:px-6">
                          <DashboardRouteTabs {...routeTabs} pathname={pathname} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
                {/* The content column takes the same gutter as the header, in a wrapper so the
                  column's box stays exactly the header's. In the locked layout the wrapper carries
                  on the flex column, so the content box still fills it. */}
                <div
                  className={cn(
                    "min-w-0 w-full",
                    shouldLockViewportScroll && "flex min-h-0 flex-1 flex-col",
                    contentTakesGutter && pageGutterClass
                  )}
                >
                  <div
                    data-dashboard-page-content={isWorkspaceSwitching ? undefined : ""}
                    className={cn(
                      "mx-auto min-w-0 w-full",
                      contentWidthClass,
                      // clip, not hidden: hidden makes this a scroll container, and a sticky wizard
                      // footer inside it would then pin to this box instead of the viewport.
                      shouldClipHorizontalOverflow &&
                        !shouldLockViewportScroll &&
                        "overflow-x-clip",
                      // The locked page clips only vertically: its scroll panel reaches past the
                      // column to the work area's edges.
                      shouldLockViewportScroll &&
                        "min-h-0 flex-1 overflow-x-visible overflow-y-clip"
                    )}
                  >
                    {isWorkspaceSwitching ? (
                      <div
                        className="h-full min-h-0"
                        data-dashboard-navigation-pending={loadingRoute}
                        role="status"
                        aria-live="polite"
                      >
                        <span className="sr-only">
                          {t("Shared.dashboardShell.loadingDashboard")}
                        </span>
                        <PageLoadingComponent
                          assetProfilesEnabled={assetProfilesEnabled}
                          flags={flags}
                        />
                      </div>
                    ) : (
                      // Switching demo mode remounts the page, so nothing a form or flow
                      // held in one mode carries into the other.
                      <Fragment key={demoMode ? "demo" : "live"}>{children}</Fragment>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </PaymentsDemoProvider>
      </DashboardShellPageContexts>
    </main>
  );
}
