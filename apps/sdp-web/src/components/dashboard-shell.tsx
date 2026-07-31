"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  LibraryIcon,
  LockIcon,
  PanelLeftIcon,
  Settings2Icon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ApiKeyAuthoringSkeleton,
  ApiKeysListSkeleton,
} from "@/app/dashboard/api-keys/api-key-page-skeletons";
import {
  ApprovalDetailSkeleton,
  ApprovalInboxSkeleton,
} from "@/app/dashboard/approvals/approval-page-skeletons";
import {
  IssuanceCreateSkeleton,
  IssuanceDetailSkeleton,
  IssuancePageSkeleton,
} from "@/app/dashboard/issuance/issuance-page-skeleton";
import DashboardLoading from "@/app/dashboard/loading";
import {
  CompactOperationsCardSkeleton,
  SettingsPageSkeleton,
} from "@/app/dashboard/operations-card-page-skeletons";
import { CounterpartyMenuLoading } from "@/app/dashboard/payments/counterparty-menu-loading";
import { PaymentsPageSkeleton } from "@/app/dashboard/payments/payments-page-skeleton";
import {
  CounterpartyCreateSkeleton,
  CounterpartyDetailSkeleton,
  PaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton,
  PaymentsTransactionsPageSkeleton,
  RecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton,
} from "@/app/dashboard/payments/payments-route-skeletons";
import { PoliciesOverviewSkeleton } from "@/app/dashboard/policies/policies-overview";
import {
  WalletDetailSkeleton,
  WalletPolicyAuditDetailSkeleton,
  WalletPolicyAuditListSkeleton,
  WalletPolicyRevisionsSkeleton,
  WalletPolicySkeleton,
  WalletSetupSkeleton,
  WalletsOverviewSkeleton,
} from "@/app/dashboard/wallets/wallet-route-skeletons";
import { DashboardBottomNav } from "@/components/dashboard-bottom-nav";
import {
  DashboardTopBar,
  getDashboardPageConfig,
  HeaderBackAction,
} from "@/components/dashboard-header";
import { DashboardHeaderTabs } from "@/components/dashboard-header-tabs";
import { DashboardMoreSheet } from "@/components/dashboard-more-sheet";
import {
  docsHref,
  getNavSections,
  type NavItem,
  type NavSection,
  PAYMENTS_SUBNAV_IDS,
} from "@/components/dashboard-nav";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { FullscreenLoadingIndicator } from "@/components/fullscreen-loading-indicator";
import { NetworkDebugPanel, NetworkDebugToggle } from "@/components/network-debug-panel";
import { SelectOrganizationPanel } from "@/components/select-organization-panel";
import { SentryFeedbackWidget } from "@/components/sentry-feedback-widget";
import { SentryUserContext } from "@/components/sentry-user-context";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import {
  DASHBOARD_NAVIGATION_RECOVERY_TIMEOUT_MS,
  DASHBOARD_NAVIGATION_START_EVENT,
  DASHBOARD_SIDE_NAV_HREFS,
  type DashboardLoadingRoute,
  type DashboardNavigationStartDetail,
  isDashboardNavItemActive,
  resolveDashboardLoadingRoute,
} from "@/lib/dashboard-navigation-loading";
import {
  type OrganizationOnboardingStatus,
  shouldRedirectToOrganizationOnboarding,
} from "@/lib/onboarding-route-guard";
import { cn } from "@/lib/utils";

function ApiKeyNewLoading() {
  return <ApiKeyAuthoringSkeleton route="api-key-new" />;
}

function ApiKeyEditLoading() {
  return <ApiKeyAuthoringSkeleton route="api-key-edit" />;
}

function AllowlistLoading() {
  return <CompactOperationsCardSkeleton route="allowlist" />;
}

interface PageLoadingProps {
  assetProfilesEnabled?: boolean;
  targetSearch?: string;
}

function CounterpartyDirectoryLoading({ targetSearch }: PageLoadingProps) {
  return <CounterpartyMenuLoading overview="counterparty-directory" targetSearch={targetSearch} />;
}

function PaymentRequestsLoading({ targetSearch }: PageLoadingProps) {
  return <CounterpartyMenuLoading overview="payment-requests" targetSearch={targetSearch} />;
}

function resolvePageLoadingComponent(
  route: DashboardLoadingRoute
): React.ComponentType<PageLoadingProps> {
  switch (route) {
    case "home":
      return DashboardLoading;
    case "wallets-overview":
      return WalletsOverviewSkeleton;
    case "wallet-setup":
      return WalletSetupSkeleton;
    case "wallet-detail":
      return WalletDetailSkeleton;
    case "wallet-policy":
      return WalletPolicySkeleton;
    case "wallet-policy-audit-list":
      return WalletPolicyAuditListSkeleton;
    case "wallet-policy-audit-detail":
      return WalletPolicyAuditDetailSkeleton;
    case "wallet-policy-revisions":
      return WalletPolicyRevisionsSkeleton;
    case "issuance-overview":
      return IssuancePageSkeleton;
    case "issuance-create":
      return IssuanceCreateSkeleton;
    case "issuance-detail":
      return IssuanceDetailSkeleton;
    case "payments-overview":
      return PaymentsPageSkeleton;
    case "payments-transactions":
      return PaymentsTransactionsPageSkeleton;
    case "payments-pay":
      return PaymentsPayPageSkeleton;
    case "payments-deposit":
      return PaymentsDepositPageSkeleton;
    case "payment-requests":
      return PaymentRequestsLoading;
    case "counterparty-directory":
      return CounterpartyDirectoryLoading;
    case "counterparty-create":
      return CounterpartyCreateSkeleton;
    case "counterparty-detail":
      return CounterpartyDetailSkeleton;
    case "recurring-payments":
      return RecurringPaymentsPageSkeleton;
    case "recurring-payment-create":
      return RecurringPaymentCreateSkeleton;
    case "recurring-payment-detail":
      return RecurringPaymentDetailSkeleton;
    case "api-keys-list":
      return ApiKeysListSkeleton;
    case "api-key-new":
      return ApiKeyNewLoading;
    case "api-key-edit":
      return ApiKeyEditLoading;
    case "policies":
      return PoliciesOverviewSkeleton;
    case "approvals-list":
      return ApprovalInboxSkeleton;
    case "approval-detail":
      return ApprovalDetailSkeleton;
    case "settings":
      return SettingsPageSkeleton;
    case "allowlist":
      return AllowlistLoading;
  }
}

const navItemBase =
  "relative flex h-10 w-full items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-base transition-colors";
const navItemActive = "border border-border-subtle bg-surface-raised text-primary";
const navItemInactive = "text-secondary hover:bg-fill-strong hover:text-primary";

function SidebarGroup({
  title,
  items,
  pathname,
  onNavigate,
  isCollapsed,
  showTopSeparator,
  paymentsSubnavOpen,
  onPaymentsSubnavToggle,
  variant,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
  isCollapsed: boolean;
  showTopSeparator: boolean;
  paymentsSubnavOpen: boolean;
  onPaymentsSubnavToggle: () => void;
  variant: "desktop" | "mobile";
}) {
  const t = useTranslations();
  return (
    <div className="space-y-2">
      <p
        className={cn(
          "relative px-3 text-xs uppercase leading-normal tracking-wide",
          isCollapsed ? "text-transparent" : "text-muted"
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
      <div className="space-y-0.5">
        {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch preserves the shared navigation item and accessible payments disclosure in one rendering pass. */}
        {items.map((item) => {
          const Icon = item.icon;
          const active = isDashboardNavItemActive(pathname, item.href);
          const isPaymentsGroup = item.href === DASHBOARD_SIDE_NAV_HREFS.payments;
          const showChildren = !isCollapsed && item.children && item.children.length > 0;
          const childrenExpanded = isPaymentsGroup ? paymentsSubnavOpen : true;
          const subnavId = isPaymentsGroup ? PAYMENTS_SUBNAV_IDS[variant] : undefined;

          return (
            <div key={item.label}>
              <div className="relative flex items-center">
                <DashboardNavigationLink
                  href={item.href}
                  onClick={onNavigate}
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
                    isPaymentsGroup && !isCollapsed && "pr-11"
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" strokeWidth={1.9} />
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
                </DashboardNavigationLink>
                {isPaymentsGroup && !isCollapsed ? (
                  <button
                    type="button"
                    aria-expanded={paymentsSubnavOpen}
                    aria-controls={subnavId}
                    aria-label={t(
                      paymentsSubnavOpen
                        ? "Shared.dashboardShell.collapsePaymentsMenu"
                        : "Shared.dashboardShell.expandPaymentsMenu"
                    )}
                    onClick={onPaymentsSubnavToggle}
                    className="absolute right-1 inline-flex size-9 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-fill-strong hover:text-primary"
                  >
                    <ChevronDownIcon
                      className={cn(
                        "size-4 transition-transform motion-reduce:transition-none",
                        !paymentsSubnavOpen && "-rotate-90"
                      )}
                    />
                  </button>
                ) : null}
              </div>
              {showChildren && childrenExpanded ? (
                <div id={subnavId} className="ml-5 mt-2">
                  {(item.children ?? []).map((child, i, siblings) => {
                    const childActive = isDashboardNavItemActive(pathname, child.href);
                    const isFirst = i === 0;
                    const isLast = i === siblings.length - 1;
                    return (
                      <div key={child.href} className="flex gap-2">
                        <div
                          className={cn(
                            "w-0.5 shrink-0 self-stretch transition-colors",
                            isFirst && "mt-1",
                            isLast && "mb-1",
                            childActive ? "bg-secondary" : "bg-fill-strong"
                          )}
                        />
                        {child.disabled ? (
                          <span className="flex h-9 flex-1 cursor-not-allowed items-center gap-2.5 rounded-lg px-3 text-sm text-tertiary">
                            {child.icon ? (
                              <child.icon aria-hidden="true" className="size-4 shrink-0" />
                            ) : null}
                            {child.label}
                            <LockIcon className="ml-auto h-3 w-3" />
                          </span>
                        ) : (
                          <DashboardNavigationLink
                            href={child.href}
                            onClick={onNavigate}
                            className={cn(
                              "flex h-9 flex-1 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors",
                              childActive ? navItemActive : navItemInactive
                            )}
                          >
                            {child.icon ? (
                              <child.icon aria-hidden="true" className="size-4 shrink-0" />
                            ) : null}
                            {child.label}
                          </DashboardNavigationLink>
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
  bottomNavItems,
  navSections,
  pathname,
  onNavigate,
  onClose,
  isCollapsed,
  variant,
  onOrganizationSwitchingChange,
  paymentsSubnavOpen,
  onPaymentsSubnavToggle,
}: {
  bottomNavItems: NavItem[];
  navSections: NavSection[];
  pathname: string;
  onNavigate?: () => void;
  onClose: () => void;
  isCollapsed: boolean;
  variant: "desktop" | "mobile";
  onOrganizationSwitchingChange: (isSwitching: boolean) => void;
  paymentsSubnavOpen: boolean;
  onPaymentsSubnavToggle: () => void;
}) {
  const t = useTranslations();
  const showMobileClose = variant === "mobile";
  return (
    <>
      <div className="min-h-0 flex-1 space-y-6 overflow-x-hidden overflow-y-auto overscroll-contain p-3">
        <div className="py-3">
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
            paymentsSubnavOpen={paymentsSubnavOpen}
            onPaymentsSubnavToggle={onPaymentsSubnavToggle}
            variant={variant}
          />
        ))}
      </div>
      <div className="shrink-0 space-y-0.5 px-3 pb-1">
        <SentryFeedbackWidget collapsed={isCollapsed} />
        {bottomNavItems.map((item) => {
          const Icon = item.icon;
          return (
            <DashboardNavigationLink
              key={item.label}
              href={item.href}
              target={item.external ? "_blank" : undefined}
              rel={item.external ? "noopener noreferrer" : undefined}
              onClick={onNavigate}
              title={isCollapsed ? item.label : undefined}
              aria-label={isCollapsed ? item.label : undefined}
              className={cn(
                "flex h-10 items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-base text-secondary transition-colors hover:bg-fill-strong hover:text-primary",
                isCollapsed && "justify-center"
              )}
            >
              <Icon className="h-5 w-5 shrink-0" strokeWidth={1.9} />
              {isCollapsed ? null : <span className="whitespace-nowrap">{item.label}</span>}
            </DashboardNavigationLink>
          );
        })}
        {variant === "desktop" ? <NetworkDebugToggle collapsed={isCollapsed} /> : null}
      </div>
    </>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this shell intentionally coordinates route-specific dashboard layout behavior in one place.
export function DashboardShell({
  assetProfilesEnabled,
  children,
  onboardingStatus,
}: {
  assetProfilesEnabled: boolean;
  children: ReactNode;
  onboardingStatus: OrganizationOnboardingStatus | null;
}) {
  const t = useTranslations();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { dashboardAccess, selectedProjectId, isSidebarOpen, setSidebarOpen, isProjectSwitching } =
    useDashboardWorkspace();
  const [isMobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isMoreSheetOpen, setMoreSheetOpen] = useState(false);
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{
    fromPathname: string;
    toPathname: string;
    toSearch: string;
  } | null>(null);
  const [pendingApprovalCount, setPendingApprovalCount] = useState<number | null>(null);
  const [paymentsSubnavOpen, setPaymentsSubnavOpen] = useState(() =>
    pathname.startsWith("/dashboard/payments")
  );
  const paymentsSubnavHydratedRef = useRef(false);
  const previousPathnameRef = useRef(pathname);
  const pendingNavigationPathname =
    pendingNavigation?.fromPathname === pathname ? pendingNavigation.toPathname : null;
  const shellPathname = pendingNavigationPathname ?? pathname;
  const loadingRoute = resolveDashboardLoadingRoute(shellPathname) ?? "home";
  const PageLoadingComponent = resolvePageLoadingComponent(loadingRoute);
  const isNavigationPending =
    Boolean(pendingNavigationPathname) || isProjectSwitching || isOrganizationSwitching;
  const sidebarExpandedWidth = 296;
  const sidebarCollapsedWidth = 64;
  const pageConfig = getDashboardPageConfig(shellPathname, t, assetProfilesEnabled);
  const navSections = getNavSections(t, {
    canReadApprovals: dashboardAccess.capabilities.canReadApprovals,
    pendingApprovalCount,
  });
  const bottomNavItems: NavItem[] = [
    {
      label: t("Shared.dashboardShell.apiDocs"),
      href: docsHref,
      icon: LibraryIcon,
      external: true,
    },
    ...(dashboardAccess.capabilities.canManageOrgSettings
      ? [
          {
            label: t("Shared.dashboardShell.settings"),
            href: DASHBOARD_SIDE_NAV_HREFS.settings,
            icon: Settings2Icon,
          },
        ]
      : []),
  ];
  const contentWidthClass = pageConfig.contentWidthClass ?? "max-w-5xl";
  const backAction = pageConfig.backAction ? (
    <HeaderBackAction
      href={pageConfig.backAction.href}
      label={pageConfig.backAction.label}
      compactOnMobile
    />
  ) : null;
  const headerTabs = pageConfig.headerTabs;
  const hasHeaderTabs = Boolean(headerTabs);
  const centeredTitle = pageConfig.centeredTitle;
  const showBackInTopBar = Boolean(backAction) && !hasHeaderTabs;
  const topBarLeadingContent = showBackInTopBar ? backAction : pageConfig.topBarLeadingContent;
  const shouldRenderTopBarBorder = (Boolean(centeredTitle) || showBackInTopBar) && !hasHeaderTabs;
  const shouldClipHorizontalOverflow =
    shellPathname === "/dashboard/payments" ||
    shellPathname === "/dashboard/payments/transactions" ||
    (shellPathname.startsWith("/dashboard/payments/") &&
      !shellPathname.startsWith("/dashboard/payments/counterparty"));
  const isWalletDetailRoute =
    (shellPathname.startsWith("/dashboard/wallets/") &&
      shellPathname !== "/dashboard/wallets/setup" &&
      shellPathname !== "/dashboard/wallets/switch") ||
    (shellPathname.startsWith("/dashboard/custody/") &&
      shellPathname !== "/dashboard/custody/setup" &&
      shellPathname !== "/dashboard/custody/switch");
  const isWalletSetupRoute =
    shellPathname === "/dashboard/wallets/setup" || shellPathname === "/dashboard/custody/setup";
  const isOrganizationOnboardingRoute = shellPathname === "/dashboard/onboarding";
  const shouldUseWorkspaceViewport =
    shellPathname === "/dashboard/issuance" ||
    shellPathname === "/dashboard/issuance/create" ||
    shellPathname === "/dashboard/policies" ||
    shellPathname === "/dashboard/api-keys" ||
    shellPathname === "/dashboard/api-keys/new" ||
    (shellPathname.startsWith("/dashboard/api-keys/") && shellPathname.endsWith("/edit")) ||
    shellPathname.startsWith("/dashboard/payments") ||
    shellPathname === "/dashboard/wallets" ||
    shellPathname === "/dashboard/custody" ||
    isWalletSetupRoute ||
    isOrganizationOnboardingRoute ||
    shellPathname.startsWith("/dashboard/approvals") ||
    isWalletDetailRoute;
  const shouldLockViewportScroll = shouldUseWorkspaceViewport;
  const shouldLockShellViewport = shouldLockViewportScroll || isMobileSidebarOpen;
  const shouldRedirectToOnboarding = shouldRedirectToOrganizationOnboarding(
    onboardingStatus,
    pathname
  );

  useEffect(() => {
    if (shouldRedirectToOnboarding) {
      router.replace("/dashboard/onboarding");
    }
  }, [router, shouldRedirectToOnboarding]);

  useEffect(() => {
    const stored = window.localStorage.getItem("sdp.dashboard.payments-subnav-open");
    if (stored === "true" || stored === "false") {
      setPaymentsSubnavOpen(stored === "true");
    }
    paymentsSubnavHydratedRef.current = true;
  }, []);

  const togglePaymentsSubnav = () => {
    setPaymentsSubnavOpen((current) => {
      const next = !current;
      if (paymentsSubnavHydratedRef.current) {
        window.localStorage.setItem("sdp.dashboard.payments-subnav-open", String(next));
      }
      return next;
    });
  };

  useEffect(() => {
    const handleProgrammaticNavigation = (event: Event) => {
      const detail = (event as CustomEvent<DashboardNavigationStartDetail>).detail;
      if (!detail?.fromPathname || !detail.toPathname) return;
      setPendingNavigation(detail);
    };

    window.addEventListener(DASHBOARD_NAVIGATION_START_EVENT, handleProgrammaticNavigation);
    return () => {
      window.removeEventListener(DASHBOARD_NAVIGATION_START_EVENT, handleProgrammaticNavigation);
    };
  }, []);

  useEffect(() => {
    if (!pendingNavigation) return;

    // A router error or middleware cancellation may never update usePathname.
    // Restore the current page instead of leaving an indefinite loading shell.
    const recoveryTimeout = window.setTimeout(() => {
      setPendingNavigation((current) => (current === pendingNavigation ? null : current));
    }, DASHBOARD_NAVIGATION_RECOVERY_TIMEOUT_MS);

    return () => window.clearTimeout(recoveryTimeout);
  }, [pendingNavigation]);

  useEffect(() => {
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      setPendingNavigation(null);
      setMobileSidebarOpen(false);
    }
  }, [pathname]);

  useEffect(() => {
    if (!dashboardAccess.capabilities.canReadApprovals || !selectedProjectId) {
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
  }, [dashboardAccess.capabilities.canReadApprovals, selectedProjectId]);

  if (!isLoaded || shouldRedirectToOnboarding) {
    return <FullscreenLoadingIndicator />;
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
    return <SelectOrganizationPanel />;
  }

  if (isOrganizationOnboardingRoute) {
    return (
      <main className="h-screen overflow-hidden bg-[var(--sdp-shell-bg)] p-2 text-primary md:p-4">
        <SentryUserContext />
        <NetworkDebugPanel />
        <div className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-border-subtle bg-surface-raised/90 shadow-sm">
          <header className="relative flex h-16 shrink-0 items-center justify-between border-b border-border-subtle px-4 md:px-6">
            <div className="min-w-0 max-w-[calc(100%-3rem)] sm:w-72">
              <WorkspaceSwitcher
                collapsed={false}
                onOrganizationSwitchingChange={setOrganizationSwitching}
              />
            </div>
            <span className="absolute left-1/2 hidden -translate-x-1/2 text-sm font-medium text-secondary sm:block">
              {t("Shared.dashboardShell.workspace")}
            </span>
          </header>
          <section className="min-h-0 flex-1">{children}</section>
        </div>
      </main>
    );
  }

  return (
    <main
      aria-busy={isNavigationPending}
      className={[
        "min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-primary",
        shouldLockShellViewport ? "h-screen overflow-hidden" : "",
      ].join(" ")}
    >
      <SentryUserContext />
      <NetworkDebugPanel />
      <div
        className={[
          "mx-auto grid min-h-screen w-full max-w-none gap-0",
          shouldLockViewportScroll ? "h-full" : "",
          "xl:grid-cols-[auto_1fr]",
        ].join(" ")}
      >
        <aside
          style={{ width: isSidebarOpen ? sidebarExpandedWidth : sidebarCollapsedWidth }}
          className="relative z-10 hidden bg-[var(--sdp-shell-bg)] xl:sticky xl:top-0 xl:flex xl:h-screen xl:flex-col xl:justify-between"
        >
          <DashboardSidebarContent
            bottomNavItems={bottomNavItems}
            navSections={navSections}
            pathname={shellPathname}
            onNavigate={undefined}
            onClose={() => setSidebarOpen(false)}
            isCollapsed={!isSidebarOpen}
            variant="desktop"
            onOrganizationSwitchingChange={setOrganizationSwitching}
            paymentsSubnavOpen={paymentsSubnavOpen}
            onPaymentsSubnavToggle={togglePaymentsSubnav}
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
            duplicate of every destination would otherwise sit behind the overlay. */}
        {isMobileSidebarOpen || isMoreSheetOpen ? null : (
          <DashboardBottomNav pathname={shellPathname} onOpenMore={() => setMoreSheetOpen(true)} />
        )}

        {isMoreSheetOpen ? (
          <DashboardMoreSheet
            pathname={shellPathname}
            canReadApprovals={dashboardAccess.capabilities.canReadApprovals}
            canManageOrgSettings={dashboardAccess.capabilities.canManageOrgSettings}
            onClose={() => setMoreSheetOpen(false)}
          />
        ) : null}

        {isMobileSidebarOpen ? (
          <div className="fixed inset-0 z-50 flex xl:hidden">
            <button
              type="button"
              aria-label={t("Shared.dashboardShell.closeNavigationOverlay")}
              className="absolute inset-0 bg-primary/30"
              onClick={() => setMobileSidebarOpen(false)}
            />
            <div className="relative z-10 flex h-full w-72 max-w-[85vw] flex-col justify-between border-r border-border-default bg-[var(--sdp-shell-bg)] shadow-lg">
              <DashboardSidebarContent
                bottomNavItems={bottomNavItems}
                navSections={navSections}
                pathname={shellPathname}
                onNavigate={() => setMobileSidebarOpen(false)}
                onClose={() => setMobileSidebarOpen(false)}
                isCollapsed={false}
                variant="mobile"
                onOrganizationSwitchingChange={setOrganizationSwitching}
                paymentsSubnavOpen={paymentsSubnavOpen}
                onPaymentsSubnavToggle={togglePaymentsSubnav}
              />
            </div>
          </div>
        ) : null}

        <section
          className={[
            "relative min-w-0 rounded-2xl border border-border-subtle bg-surface-raised/80 xl:rounded-tl-[16px]",
            shouldLockViewportScroll ? "flex min-h-0 flex-col overflow-hidden" : "px-3 py-5 md:p-6",
          ].join(" ")}
        >
          <div
            className={[
              "min-w-0 w-full",
              shouldLockViewportScroll ? "flex min-h-0 flex-1 flex-col" : "space-y-6",
            ].join(" ")}
          >
            <div className="shrink-0 space-y-4">
              <div
                className={cn(
                  shouldRenderTopBarBorder && "border-b border-border-default pb-5 md:pb-6",
                  shouldLockViewportScroll
                    ? "px-3 pt-5 md:px-6 md:pt-6"
                    : shouldRenderTopBarBorder && "-mx-3 px-3 md:-mx-6 md:px-6"
                )}
              >
                <DashboardTopBar
                  isMobileSidebarOpen={isMobileSidebarOpen}
                  setMobileSidebarOpen={setMobileSidebarOpen}
                  hideTitle={pageConfig.hideTitle}
                  title={pageConfig.title}
                  centeredTitle={centeredTitle}
                  topBarLeadingContent={topBarLeadingContent}
                  hasHeaderTabs={hasHeaderTabs}
                />
              </div>

              {headerTabs ? (
                <div
                  className={cn(
                    "border-b border-border-default",
                    !shouldLockViewportScroll && "-mx-3 md:-mx-6"
                  )}
                >
                  <div className="flex items-end px-3 md:px-6">
                    <DashboardHeaderTabs {...headerTabs} />
                  </div>
                </div>
              ) : null}
            </div>
            <div
              data-dashboard-page-content={isNavigationPending ? undefined : ""}
              className={[
                "mx-auto min-w-0 w-full",
                contentWidthClass,
                // Clears the fixed mobile bottom bar so the last row of any page is
                // still reachable; the bar is xl:hidden, so the padding is too.
                shouldLockViewportScroll ? "" : "pb-20 xl:pb-0",
                shouldClipHorizontalOverflow && !shouldLockViewportScroll
                  ? "overflow-x-hidden"
                  : "",
                shouldLockViewportScroll ? "min-h-0 flex-1 overflow-hidden" : "",
              ].join(" ")}
            >
              {isNavigationPending ? (
                <div
                  className="h-full min-h-0"
                  data-dashboard-navigation-pending={loadingRoute}
                  role="status"
                  aria-live="polite"
                >
                  <span className="sr-only">{t("Shared.dashboardShell.loadingDashboard")}</span>
                  <PageLoadingComponent
                    assetProfilesEnabled={assetProfilesEnabled}
                    targetSearch={pendingNavigation?.toSearch}
                  />
                </div>
              ) : (
                children
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
