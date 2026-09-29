"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import { ChevronDownIcon, ChevronLeftIcon, LockIcon, PanelLeftIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DashboardBottomNav } from "@/components/dashboard-bottom-nav";
import {
  DashboardHeaderAction,
  DashboardTopBar,
  getDashboardPageConfig,
  HeaderBackAction,
} from "@/components/dashboard-header";
import { DashboardHeaderTabs } from "@/components/dashboard-header-tabs";
import { DashboardLoadingScreen } from "@/components/dashboard-loading-screen";
import { DashboardMoreSheet } from "@/components/dashboard-more-sheet";
import {
  DASHBOARD_SUBNAV_GROUPS,
  type DashboardSubnavKey,
  dashboardSubnavId,
  dashboardSubnavStorageKey,
  getNavSections,
  type NavItem,
  type NavSection,
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
import { PaymentsDemoToggle } from "@/components/payments-demo-toggle";
import { SentryUserContext } from "@/components/sentry-user-context";
import { SidebarUserMenu } from "@/components/sidebar-user-menu";
import { themeScopeAttributes } from "@/components/theme-scope";
import { ThemeScopeProvider } from "@/components/theme-scope-provider";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { DashboardFlags } from "@/flags/dashboard";
import { useTranslations } from "@/i18n/provider";
import {
  isDashboardNavItemActive,
  resolveDashboardLoadingRoute,
} from "@/lib/dashboard-navigation-loading";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { isPaymentsPath } from "@/lib/payments-demo/demo-cookie";
import { themeScopeForPath } from "@/lib/theme-scope-routes";
import { cn } from "@/lib/utils";

// The refresh sidebar is the design's: 40px rows touching, 6px corners, a 20px icon then 16px to
// the 15px medium label, an ink wash for the active row and a lighter one on hover, no border.
const navItemBase =
  "relative flex h-10 w-full items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-base transition-colors refresh:h-control-lg refresh:gap-4 refresh:rounded-control refresh:px-2 refresh:text-nav refresh:font-medium";
const navItemActive =
  "border border-border-subtle bg-surface-raised text-primary refresh:border-0 refresh:bg-fill-strong";
const navItemInactive =
  "text-secondary hover:bg-fill-strong hover:text-primary refresh:text-primary refresh:hover:bg-fill";
// Sub-items keep the secondary ink until active; the design indents them under the icon
// column instead of drawing a rail beside them.
const childNavItemBase =
  "flex h-9 flex-1 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors refresh:h-control-md refresh:rounded-control refresh:pr-2 refresh:pl-[52px] refresh:text-nav";
const childNavItemActive = `${navItemActive} refresh:font-medium`;
const childNavItemInactive =
  "text-secondary hover:bg-fill-strong hover:text-primary refresh:hover:bg-fill";

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
  const search = useSearchParams().toString();
  const navigationLocation = search ? `${pathname}?${search}` : pathname;
  return (
    <div className="space-y-2">
      <p
        className={cn(
          "relative px-3 text-xs uppercase leading-normal tracking-wide refresh:px-2 refresh:text-meta refresh:normal-case refresh:leading-4 refresh:tracking-normal",
          isCollapsed ? "text-transparent" : "text-muted refresh:text-secondary"
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
      <div className="space-y-0.5 refresh:space-y-0">
        {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch preserves the shared navigation item and accessible payments disclosure in one rendering pass. */}
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
                  href={item.href}
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
                  aria-label={
                    isCollapsed && item.badge
                      ? `${item.label}, ${t("Shared.dashboardShell.pendingApprovals", { count: item.badge })}`
                      : isCollapsed
                        ? item.label
                        : undefined
                  }
                  className={cn(
                    navItemBase,
                    active ? navItemActive : navItemInactive,
                    isCollapsed && "justify-center",
                    subnavKey && !isCollapsed && "pr-11"
                  )}
                >
                  <Icon
                    className="h-5 w-5 shrink-0 refresh:size-5 refresh:text-primary/45"
                    strokeWidth={1.9}
                  />
                  {isCollapsed ? null : (
                    <>
                      <span className="whitespace-nowrap">{item.label}</span>
                      {item.badge ? (
                        <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium text-on-primary">
                          {item.badge > 99 ? "99+" : item.badge}
                        </span>
                      ) : null}
                    </>
                  )}
                  {isCollapsed && item.badge ? (
                    <span
                      className="absolute top-1 right-1 size-2 rounded-full border border-on-primary bg-primary"
                      aria-hidden="true"
                    />
                  ) : null}
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
                    className="absolute right-1 inline-flex size-9 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-fill-strong hover:text-primary refresh:right-0 refresh:size-8 refresh:rounded-control"
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
                <div
                  id={subnavId}
                  className="ml-5 mt-2 refresh:mt-1 refresh:ml-0 refresh:space-y-1"
                >
                  {(item.children ?? []).map((child, i, siblings) => {
                    const childActive = isDashboardNavItemActive(navigationLocation, child.href);
                    const isFirst = i === 0;
                    const isLast = i === siblings.length - 1;
                    return (
                      <div key={child.href} className="flex gap-2 refresh:gap-0">
                        <div
                          className={cn(
                            "w-0.5 shrink-0 self-stretch transition-colors refresh:hidden",
                            isFirst && "mt-1",
                            isLast && "mb-1",
                            childActive ? "bg-secondary" : "bg-fill-strong"
                          )}
                        />
                        {child.disabled ? (
                          <span
                            className={cn(childNavItemBase, "cursor-not-allowed text-tertiary")}
                          >
                            {child.icon ? (
                              <child.icon
                                aria-hidden="true"
                                className="size-4 shrink-0 refresh:hidden"
                              />
                            ) : null}
                            {child.label}
                            <LockIcon className="ml-auto h-3 w-3" />
                          </span>
                        ) : (
                          <Link
                            href={child.href}
                            onClick={onNavigate}
                            className={cn(
                              childNavItemBase,
                              childActive ? childNavItemActive : childNavItemInactive
                            )}
                          >
                            {child.icon ? (
                              <child.icon
                                aria-hidden="true"
                                className="size-4 shrink-0 refresh:hidden"
                              />
                            ) : null}
                            {child.label}
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
  canManageOrgSettings,
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
  canManageOrgSettings: boolean;
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
      {/* Refresh: an 8px inset, the workspace row hugging the top, and a scrollbar that only
          shows under the pointer, so the rows keep the design's full 256px width. */}
      <div className="sdp-quiet-scroll min-h-0 flex-1 space-y-6 overflow-x-hidden overflow-y-auto overscroll-contain p-3 refresh:p-2">
        {/* -4px above pulls the 32px avatar to the 8px inset inside its 40px row; 20px below
            keeps the group gap at 24 from the avatar's bottom. */}
        <div className="py-3 refresh:-mt-1 refresh:mb-5 refresh:py-0">
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
      <div className="shrink-0 space-y-3 px-3 pb-3 refresh:px-2 refresh:pb-2">
        {showQuickStart ? <DashboardQuickStart collapsed={isCollapsed} /> : null}
        <SidebarUserMenu
          collapsed={isCollapsed}
          canManageOrgSettings={canManageOrgSettings}
          // The mobile slide-over is a 288px column, so the popover only has
          // room above the trigger there.
          menuSide={variant === "desktop" ? "right" : "top"}
        />
      </div>
    </>
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
    (pathname.startsWith("/dashboard/wallets/") &&
      pathname !== "/dashboard/wallets/setup" &&
      pathname !== "/dashboard/wallets/switch") ||
    (pathname.startsWith("/dashboard/custody/") &&
      pathname !== "/dashboard/custody/setup" &&
      pathname !== "/dashboard/custody/switch");
  const isWalletSetupRoute =
    pathname === "/dashboard/wallets/setup" || pathname === "/dashboard/custody/setup";

  return (
    pathname === "/dashboard/issuance" ||
    pathname === "/dashboard/issuance/create" ||
    pathname === "/dashboard/policies" ||
    pathname === "/dashboard/api-keys" ||
    pathname === "/dashboard/api-keys/new" ||
    (pathname.startsWith("/dashboard/api-keys/") && pathname.endsWith("/edit")) ||
    pathname.startsWith("/dashboard/payments") ||
    pathname.startsWith("/dashboard/markets") ||
    pathname === "/dashboard/wallets" ||
    pathname === "/dashboard/custody" ||
    isWalletSetupRoute ||
    pathname.startsWith("/dashboard/integrations/private-channels") ||
    pathname.startsWith("/dashboard/approvals") ||
    isWalletDetailRoute
  );
}

/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing shell orchestration */ /* react-doctor-disable-next-line no-high-complexity-react-function -- this change only supplies Private Channels route configuration */
export function DashboardShell({
  children,
  flags,
}: {
  children: ReactNode;
  flags: DashboardFlags;
}) {
  const {
    assetProfiles: assetProfilesEnabled,
    custody: custodyEnabled,
    dvp: dvpEnabled,
    earn: earnEnabled,
    heliusRings: heliusRingsEnabled,
    issuance: issuanceEnabled,
    markets: marketsEnabled,
    payments: paymentsEnabled,
    policies: policiesEnabled,
    privateChannels: privateChannelsEnabled,
  } = flags;
  const t = useTranslations();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const pathname = usePathname();
  const { dashboardAccess, selectedProjectId, isSidebarOpen, setSidebarOpen, isProjectSwitching } =
    useDashboardWorkspace();
  const [isMobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isMoreSheetOpen, setMoreSheetOpen] = useState(false);
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);
  const [pendingApprovalCount, setPendingApprovalCount] = useState<number | null>(null);
  // A page whose title is data (a contact's name) names itself here.
  const [pageTitleOverride, setPageTitleOverride] = useState<DashboardPageTitleOverride | null>(
    null
  );
  const [openSubnavs, setOpenSubnavs] = useState<Record<DashboardSubnavKey, boolean>>(() => {
    const initial = {} as Record<DashboardSubnavKey, boolean>;
    for (const [key, group] of Object.entries(DASHBOARD_SUBNAV_GROUPS)) {
      initial[key as DashboardSubnavKey] = pathname.startsWith(group.pathPrefix);
    }
    return initial;
  });
  const subnavHydratedRef = useRef(false);
  const previousPathnameRef = useRef(pathname);
  const loadingRoute = resolveDashboardLoadingRoute(pathname) ?? "home";
  const PageLoadingComponent = resolvePageLoadingComponent(loadingRoute);
  const isWorkspaceSwitching = isProjectSwitching || isOrganizationSwitching;
  const themeScope = themeScopeForPath(pathname);
  const isRefresh = themeScope === "refresh";
  // The design's sidebar is 272px (17rem) including its rule; the base shell keeps its 296.
  const sidebarExpandedWidth = isRefresh ? 272 : 296;
  const sidebarCollapsedWidth = 64;
  const pageConfig = getDashboardPageConfig(
    pathname,
    t,
    assetProfilesEnabled,
    privateChannelsEnabled,
    custodyEnabled,
    paymentsEnabled,
    policiesEnabled
  );
  const navSections = getNavSections(t, {
    canReadApprovals: dashboardAccess.capabilities.canReadApprovals,
    custodyEnabled,
    dvpEnabled,
    earnEnabled,
    heliusRingsEnabled,
    issuanceEnabled,
    marketsEnabled,
    paymentsEnabled,
    pendingApprovalCount,
    policiesEnabled,
    privateChannelsEnabled,
  });
  const pageTitle =
    pageTitleOverride !== null && pageTitleOverride.pathname === pathname
      ? pageTitleOverride.title
      : pageConfig.title;
  const contentWidthClass = pageConfig.contentWidthClass ?? "max-w-5xl";
  const headerTabs = pageConfig.headerTabs;
  const routeTabs = pageConfig.routeTabs;
  const hasHeaderTabs = Boolean(headerTabs || routeTabs);
  // A refresh action page sets its way back over a left title, in the page's column, as the
  // design does; the base shell keeps it in the title row beside a centred title.
  const stacksBackAboveTitle = isRefresh && Boolean(pageConfig.backAction) && !hasHeaderTabs;
  const backAction = pageConfig.backAction ? (
    <HeaderBackAction
      href={pageConfig.backAction.href}
      label={pageConfig.backAction.label}
      compactOnMobile={!stacksBackAboveTitle}
    />
  ) : null;
  const showBackInTopBar = Boolean(backAction) && !hasHeaderTabs && !stacksBackAboveTitle;
  const topBarLeadingContent = showBackInTopBar ? backAction : pageConfig.topBarLeadingContent;
  const shouldRenderTopBarBorder =
    (pageConfig.titlePosition === "center" || showBackInTopBar) && !hasHeaderTabs && !isRefresh;
  const shouldClipHorizontalOverflow = clipsDashboardHorizontalOverflow(pathname);
  const shouldLockViewportScroll = usesWorkspaceViewport(pathname);
  const shouldLockShellViewport = shouldLockViewportScroll || isMobileSidebarOpen;
  // The dashboard's own URL store rather than useSearchParams: list filters update the query
  // shallowly, and an export has to follow them.
  const { searchParams: urlSearchParams } = useDashboardUrlState();
  const headerAction = pageConfig.headerAction ? (
    <DashboardHeaderAction action={pageConfig.headerAction} search={urlSearchParams.toString()} />
  ) : null;
  // Refresh pages put the title, the tabs and the content in one column with one gutter, so all
  // three share a left edge, and drop the full-bleed rule under the tabs. The column is the
  // design's 900px page column, or the flow's 660px when the page's content box is wider than
  // its header (a flow's footer band spans the whole page).
  const alignsHeaderWithContent = isRefresh;
  const pageColumnClass = pageConfig.headerWidthClass ?? contentWidthClass;
  const refreshGutterClass = "px-4 md:px-6";
  // A flow lays out its own gutter and column (its footer band needs the full width), so only
  // pages with a bounded content box take the shell's gutter.
  const contentTakesGutter = isRefresh && contentWidthClass !== "max-w-none";

  useEffect(() => {
    const tabletViewport = window.matchMedia("(min-width: 768px)");
    const closeMobileNavigation = () => {
      if (tabletViewport.matches) {
        setMobileSidebarOpen(false);
        setMoreSheetOpen(false);
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

  useEffect(() => {
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      setMobileSidebarOpen(false);
    }
  }, [pathname]);

  useEffect(() => {
    if (!policiesEnabled || !dashboardAccess.capabilities.canReadApprovals || !selectedProjectId) {
      setPendingApprovalCount(null);
      return;
    }

    let ignored = false;
    setPendingApprovalCount(null);
    const refreshPendingCount = async () => {
      try {
        const response = await fetch("/api/dashboard/approval-requests?status=pending&limit=100", {
          cache: "no-store",
        });
        const body = (await response.json().catch(() => null)) as {
          data?: { approvalRequests?: unknown[] };
        } | null;
        if (!ignored && response.ok) {
          setPendingApprovalCount(body?.data?.approvalRequests?.length ?? 0);
        }
      } catch {
        if (!ignored) setPendingApprovalCount(null);
      }
    };

    refreshPendingCount();
    window.addEventListener("sdp:approval-requests-updated", refreshPendingCount);
    return () => {
      ignored = true;
      window.removeEventListener("sdp:approval-requests-updated", refreshPendingCount);
    };
  }, [dashboardAccess.capabilities.canReadApprovals, policiesEnabled, selectedProjectId]);

  if (!isLoaded) {
    return (
      <DashboardLoadingScreen pathname={pathname} flags={flags} isSidebarOpen={isSidebarOpen} />
    );
  }

  if (!isSignedIn) {
    return (
      <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-primary">
        <div className="mx-auto max-w-3xl border border-border-subtle bg-surface-raised/70 p-6">
          <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
            {t("Shared.dashboardShell.signInToContinue")}
          </h1>
          <p className="mt-3 text-sm text-tertiary">
            {t("Shared.dashboardShell.signInDescription")}
          </p>
          <div className="mt-6">
            <SignInButton mode="modal">
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center rounded-[var(--button-radius-lg)] bg-primary px-[18px] text-[15px] font-semibold leading-[15px] text-on-primary transition hover:opacity-90"
              >
                {t("Shared.dashboardShell.signIn")}
              </button>
            </SignInButton>
          </div>
        </div>
      </main>
    );
  }

  if (!orgId) {
    return (
      <DashboardLoadingScreen pathname={pathname} flags={flags} isSidebarOpen={isSidebarOpen} />
    );
  }

  return (
    // On a refresh route the whole screen carries the scope, sidebar included, so the shell
    // renders in the design's papers and face. Other routes keep the base shell.
    <main
      {...themeScopeAttributes(themeScope)}
      aria-busy={isWorkspaceSwitching}
      className={[
        "min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-primary",
        shouldLockShellViewport ? "h-screen overflow-hidden" : "",
      ].join(" ")}
    >
      <ThemeScopeProvider scope={themeScope}>
        <DashboardPageTitleContext.Provider value={setPageTitleOverride}>
          <SentryUserContext />
          <NetworkDebugPanel />
          <div
            className={[
              "mx-auto grid min-h-screen w-full max-w-none gap-0",
              shouldLockViewportScroll ? "h-full" : "",
              "md:grid-cols-[auto_1fr]",
            ].join(" ")}
          >
            <aside
              style={{
                width: isSidebarOpen ? sidebarExpandedWidth : sidebarCollapsedWidth,
              }}
              className="relative z-10 hidden bg-[var(--sdp-shell-bg)] md:sticky md:top-0 md:flex md:h-screen md:flex-col md:justify-between refresh:border-r refresh:border-border-default"
            >
              <DashboardSidebarContent
                canManageOrgSettings={dashboardAccess.capabilities.canManageOrgSettings}
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

            {/* Unmounted, not CSS-hidden, while the slide-over is open: a covered
            duplicate of every destination would otherwise sit behind the overlay. A refresh
            route has no bar at all: the design's phone reaches the navigation through the
            menu button over the title. */}
            {isRefresh || isMobileSidebarOpen || isMoreSheetOpen ? null : (
              <DashboardBottomNav
                pathname={pathname}
                custodyEnabled={custodyEnabled}
                issuanceEnabled={issuanceEnabled}
                paymentsEnabled={paymentsEnabled}
                onOpenMore={() => setMoreSheetOpen(true)}
              />
            )}

            {isMoreSheetOpen ? (
              <DashboardMoreSheet
                pathname={pathname}
                canReadApprovals={dashboardAccess.capabilities.canReadApprovals}
                canManageOrgSettings={dashboardAccess.capabilities.canManageOrgSettings}
                dvpEnabled={dvpEnabled}
                earnEnabled={earnEnabled}
                heliusRingsEnabled={heliusRingsEnabled}
                marketsEnabled={marketsEnabled}
                policiesEnabled={policiesEnabled}
                onClose={() => setMoreSheetOpen(false)}
              />
            ) : null}

            {isMobileSidebarOpen ? (
              <div className="fixed inset-0 z-50 flex md:hidden">
                <button
                  type="button"
                  aria-label={t("Shared.dashboardShell.closeNavigationOverlay")}
                  className="absolute inset-0 bg-primary/30"
                  onClick={() => setMobileSidebarOpen(false)}
                />
                <div className="relative z-10 flex h-full w-72 max-w-[85vw] flex-col justify-between border-r border-border-default bg-[var(--sdp-shell-bg)] shadow-lg refresh:shadow-none">
                  <DashboardSidebarContent
                    canManageOrgSettings={dashboardAccess.capabilities.canManageOrgSettings}
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

            {/* The refresh page is flat: no card, no radius; the sidebar's rule separates it. The
              `page` group lets the header react to the content (an empty state hiding the
              header's action). On a refresh route it is also the work area's size container:
              the scroll panel reads its width (`100cqw`) to span it edge to edge. */}
            <section
              className={cn(
                "group/page relative min-w-0 rounded-2xl rounded-tr-none border border-border-subtle bg-surface-raised/80 refresh:rounded-none refresh:border-0 refresh:bg-surface-raised",
                isRefresh && "@container",
                // The locked layout clears the phone's bottom bar; a refresh route has none, so it
                // keeps only the home indicator's inset.
                shouldLockViewportScroll
                  ? [
                      "flex min-h-0 flex-col overflow-hidden md:pb-0",
                      isRefresh
                        ? "pb-[env(safe-area-inset-bottom)]"
                        : "pb-[calc(4rem+env(safe-area-inset-bottom))]",
                    ]
                  : isRefresh
                    ? "py-0"
                    : "px-3 py-5 md:p-6"
              )}
            >
              <div
                className={[
                  "min-w-0 w-full",
                  shouldLockViewportScroll
                    ? "flex min-h-0 flex-1 flex-col"
                    : pageConfig.hideTitleOnMobile
                      ? "space-y-4 sm:space-y-6"
                      : "space-y-6",
                ].join(" ")}
              >
                {/* Refresh: the gutter sits outside the centred column, so the title's left edge is
                  the content's at every width; 32px above the title and 24px from the title to
                  the tabs are the design's. */}
                <div className={cn("shrink-0", isRefresh && [refreshGutterClass, "pt-6 md:pt-8"])}>
                  <div
                    className={cn(
                      "space-y-4",
                      alignsHeaderWithContent && ["mx-auto w-full space-y-6", pageColumnClass]
                    )}
                  >
                    <div
                      className={cn(
                        shouldRenderTopBarBorder && "border-b border-border-default pb-5 md:pb-6",
                        !isRefresh &&
                          (shouldLockViewportScroll
                            ? "px-3 pt-5 md:px-6 md:pt-6"
                            : shouldRenderTopBarBorder && "-mx-3 px-3 md:-mx-6 md:px-6")
                      )}
                    >
                      <DashboardTopBar
                        isMobileSidebarOpen={isMobileSidebarOpen}
                        setMobileSidebarOpen={setMobileSidebarOpen}
                        titleVisibility={
                          pageConfig.hideTitle
                            ? "screen-reader-only"
                            : pageConfig.hideTitleOnMobile
                              ? "desktop-only"
                              : "visible"
                        }
                        title={pageTitle}
                        titlePosition={stacksBackAboveTitle ? "left" : pageConfig.titlePosition}
                        topBarLeadingContent={topBarLeadingContent}
                        hasHeaderTabs={hasHeaderTabs}
                        action={headerAction}
                        above={stacksBackAboveTitle ? backAction : undefined}
                        layout={isRefresh ? "refresh" : "base"}
                        utilities={isPaymentsPath(pathname) ? <PaymentsDemoToggle /> : undefined}
                      />
                    </div>

                    {headerTabs ? (
                      <div
                        className={cn(
                          !alignsHeaderWithContent && "border-b border-border-default",
                          !shouldLockViewportScroll && !alignsHeaderWithContent && "-mx-3 md:-mx-6"
                        )}
                      >
                        <div
                          className={cn(
                            "flex items-end",
                            alignsHeaderWithContent
                              ? "sdp-quiet-scroll min-w-0 overflow-x-auto"
                              : "px-3 md:px-6"
                          )}
                        >
                          <DashboardHeaderTabs {...headerTabs} />
                        </div>
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
                {/* On a refresh page the content column takes the same gutter as the header, in a
                  wrapper so the column's box stays exactly the header's. In the locked layout
                  the wrapper carries on the flex column, so the content box still fills it. */}
                <div
                  className={cn(
                    "min-w-0 w-full",
                    shouldLockViewportScroll && "flex min-h-0 flex-1 flex-col",
                    contentTakesGutter && refreshGutterClass
                  )}
                >
                  <div
                    data-dashboard-page-content={isWorkspaceSwitching ? undefined : ""}
                    className={[
                      "mx-auto min-w-0 w-full",
                      contentWidthClass,
                      // Clears the fixed mobile bottom bar so the last row of any page is
                      // still reachable; the bar is md:hidden, so the padding is too. A refresh
                      // route has no bar.
                      !shouldLockViewportScroll && !isRefresh ? "pb-20 md:pb-0" : "",
                      // clip, not hidden: hidden makes this a scroll container, and a sticky wizard
                      // footer inside it would then pin to this box instead of the viewport.
                      shouldClipHorizontalOverflow && !shouldLockViewportScroll
                        ? "overflow-x-clip"
                        : "",
                      // A refresh page clips only vertically: its scroll panel reaches past the
                      // column to the work area's edges.
                      shouldLockViewportScroll
                        ? isRefresh
                          ? "min-h-0 flex-1 overflow-x-visible overflow-y-clip"
                          : "min-h-0 flex-1 overflow-hidden"
                        : "",
                    ].join(" ")}
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
                        <PageLoadingComponent assetProfilesEnabled={assetProfilesEnabled} />
                      </div>
                    ) : (
                      children
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </DashboardPageTitleContext.Provider>
      </ThemeScopeProvider>
    </main>
  );
}
