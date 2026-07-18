"use client";

import { OrganizationSwitcher, SignInButton, UserButton, useAuth } from "@clerk/nextjs";
import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  CircleCheckBigIcon,
  CoinsIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  LockIcon,
  PanelLeftIcon,
  PanelRightIcon,
  Settings2Icon,
  ShieldCheckIcon,
  WalletIcon,
} from "lucide-react";
import { usePathname } from "next/navigation";
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
import { PaymentsPageSkeleton } from "@/app/dashboard/payments/payments-page-skeleton";
import {
  CounterpartyCreateSkeleton,
  CounterpartyDetailSkeleton,
  CounterpartyDirectorySkeleton,
  PaymentRequestsPageSkeleton,
  PaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton,
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
import { CounterpartyHeaderTabs } from "@/components/counterparty-header-tabs";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { IssuanceHeaderTabs } from "@/components/issuance-header-tabs";
import { LanguagePicker } from "@/components/language-picker";
import { NetworkDebugPanel } from "@/components/network-debug-panel";
import { SentryFeedbackWidget } from "@/components/sentry-feedback-widget";
import { SentryUserContext } from "@/components/sentry-user-context";
import { Badge } from "@/components/ui/badge";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import {
  DASHBOARD_NAVIGATION_RECOVERY_TIMEOUT_MS,
  DASHBOARD_NAVIGATION_START_EVENT,
  DASHBOARD_PAYMENTS_SUBNAV_HREFS,
  DASHBOARD_SIDE_NAV_HREFS,
  type DashboardLoadingRoute,
  type DashboardNavigationStartDetail,
  resolveDashboardLoadingRoute,
} from "@/lib/dashboard-navigation-loading";
import { cn } from "@/lib/utils";

type SubNavItem = {
  label: string;
  href: string;
  disabled?: boolean;
};

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: number;
  external?: boolean;
  children?: SubNavItem[];
};

type NavSection = {
  title: string;
  items: NavItem[];
};

function getPaymentsActions(t: ReturnType<typeof useTranslations>): SubNavItem[] {
  return [
    {
      label: t("Shared.dashboardShell.counterparty"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.counterparty,
    },
    { label: t("Shared.dashboardShell.pay"), href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.pay },
    {
      label: t("Shared.dashboardShell.deposit"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.deposit,
    },
    {
      label: t("Shared.dashboardShell.requests"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.requests,
    },
    {
      label: t("Shared.dashboardShell.recurring"),
      href: DASHBOARD_PAYMENTS_SUBNAV_HREFS.recurring,
    },
  ];
}

function getNavSections(
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

const docsHref =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:3001/docs" : DEFAULT_SDP_DOCS_URL);

type DashboardPageConfig = {
  title: string;
  headerNav?: ReactNode;
  centeredTitle?: string;
  topBarLeadingContent?: ReactNode;
  showHeaderNavRow?: boolean;
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
  centeredTitle?: string;
  topBarLeadingContent?: ReactNode;
};

function HeaderBackAction({
  href,
  label,
  compactOnMobile = false,
}: {
  href: string;
  label: string;
  compactOnMobile?: boolean;
}) {
  return (
    <DashboardNavigationLink
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
    </DashboardNavigationLink>
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
      className={[
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-fill-strong lg:hidden",
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
      className="grid min-h-[40px] min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 sm:grid-cols-[1fr_auto_1fr]"
      data-dashboard-centered-topbar
    >
      <div className="flex min-w-0 items-center gap-3">{leadingContent}</div>
      <div className="col-span-2 row-start-2 flex min-w-0 items-start justify-center sm:col-span-1 sm:col-start-2 sm:row-start-1">
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

function DashboardTopBar({
  isMobileSidebarOpen,
  setMobileSidebarOpen,
  hideTitle,
  title,
  centeredTitle,
  topBarLeadingContent,
}: DashboardTopBarProps) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const isSandbox = sdpEnvironment === "sandbox";
  const sandboxBadge = isSandbox ? (
    <>
      <span aria-hidden="true" className="h-4 w-px bg-fill-strong" />
      <Badge>{t("Shared.dashboardShell.sandbox")}</Badge>
    </>
  ) : null;

  if (centeredTitle) {
    return (
      <CenteredDashboardTopBar
        title={centeredTitle}
        leadingContent={
          <>
            <SidebarToggle
              isMobileSidebarOpen={isMobileSidebarOpen}
              setMobileSidebarOpen={setMobileSidebarOpen}
            />
            {topBarLeadingContent}
          </>
        }
        trailingContent={
          <>
            <LanguagePicker />
            <UserButton />
            {sandboxBadge}
          </>
        }
      />
    );
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <SidebarToggle
          isMobileSidebarOpen={isMobileSidebarOpen}
          setMobileSidebarOpen={setMobileSidebarOpen}
        />
        {hideTitle ? null : (
          <h1 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-primary">
            {title}
          </h1>
        )}
      </div>

      <div className="flex items-center gap-2">
        <LanguagePicker />
        <UserButton />
        {sandboxBadge}
      </div>
    </div>
  );
}

function actionPageConfig(config: {
  centeredTitle: string;
  backHref: string;
  backLabel: string;
  contentWidthClass: string;
}): DashboardPageConfig {
  return {
    title: "",
    hideTitle: true,
    showHeaderNavRow: true,
    centeredTitle: config.centeredTitle,
    topBarLeadingContent: (
      <HeaderBackAction href={config.backHref} label={config.backLabel} compactOnMobile />
    ),
    contentWidthClass: config.contentWidthClass,
  };
}

function getCounterpartyRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  if (pathname === "/dashboard/payments/counterparty/create") {
    return actionPageConfig({
      centeredTitle: t("Shared.dashboardShell.newCounterparty"),
      backHref: "/dashboard/payments/counterparty",
      backLabel: t("Shared.dashboardShell.backToCounterparty"),
      contentWidthClass: "max-w-xl",
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

function getWalletRoutePageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig | null {
  const walletPolicyRouteMatch = pathname.match(
    /^\/dashboard\/(wallets|custody)\/([^/]+)\/policy(?:\/|$)/
  );
  if (walletPolicyRouteMatch) {
    const [, section, walletId] = walletPolicyRouteMatch;
    return actionPageConfig({
      centeredTitle: t("Shared.dashboardShell.walletControls"),
      backHref: `/dashboard/${section}/${walletId}`,
      backLabel: t("Shared.dashboardShell.backToWallet"),
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
      showHeaderNavRow: true,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/api-keys/new") {
    return actionPageConfig({
      centeredTitle: t("Shared.dashboardShell.newApiKey"),
      backHref: "/dashboard/api-keys",
      backLabel: t("Shared.dashboardShell.backToApiKeys"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname.startsWith("/dashboard/api-keys/") && pathname.endsWith("/edit")) {
    return actionPageConfig({
      centeredTitle: t("Shared.dashboardShell.editApiKey"),
      backHref: "/dashboard/api-keys",
      backLabel: t("Shared.dashboardShell.backToApiKeys"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname.startsWith("/dashboard/approvals")) {
    return {
      title: t("Shared.dashboardShell.approvals"),
      contentWidthClass: "max-w-none",
      ...(pathname === "/dashboard/approvals"
        ? {}
        : {
            backAction: {
              href: "/dashboard/approvals",
              label: t("Shared.dashboardShell.backToApprovals"),
            },
          }),
    };
  }

  return null;
}

function getDashboardPageConfig(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): DashboardPageConfig {
  const accessControlPageConfig = getAccessControlPageConfig(pathname, t);
  if (accessControlPageConfig) return accessControlPageConfig;
  if (pathname === "/dashboard") {
    return {
      title: t("Shared.dashboardShell.home"),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/wallets" || pathname === "/dashboard/custody") {
    return {
      title: t("Shared.dashboardShell.wallets"),
      headerNav: <IssuanceHeaderTabs />,
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
  const walletRoutePageConfig = getWalletRoutePageConfig(pathname, t);
  if (walletRoutePageConfig) return walletRoutePageConfig;
  if (pathname === "/dashboard/policies") {
    return actionPageConfig({
      centeredTitle: t("Shared.dashboardShell.policies"),
      backHref: "/dashboard",
      backLabel: t("Shared.dashboardShell.backToOverview"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname === "/dashboard/issuance") {
    return {
      title: t("Shared.dashboardShell.issuance"),
      headerNav: <IssuanceHeaderTabs />,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/issuance/create") {
    return actionPageConfig({
      centeredTitle: t("Shared.dashboardShell.newAsset"),
      backHref: "/dashboard/issuance",
      backLabel: t("Shared.dashboardShell.backToOverview"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname.startsWith("/dashboard/issuance/")) {
    return {
      title: t("Shared.dashboardShell.issuance"),
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/issuance",
        label: t("Shared.dashboardShell.backToOverview"),
      },
    };
  }
  if (pathname === "/dashboard/payments/counterparty") {
    return {
      title: t("Shared.dashboardShell.counterparty"),
      headerNav: <CounterpartyHeaderTabs />,
      contentWidthClass: "max-w-none",
    };
  }
  const counterpartyRouteConfig = getCounterpartyRoutePageConfig(pathname, t);
  if (counterpartyRouteConfig) {
    return counterpartyRouteConfig;
  }
  if (pathname === "/dashboard/payments") {
    return {
      title: t("Shared.dashboardShell.payments"),
      headerNav: <IssuanceHeaderTabs />,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/payments/requests") {
    return {
      title: t("Shared.dashboardShell.requests"),
      headerNav: <CounterpartyHeaderTabs />,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/payments/recurring") {
    return {
      title: t("Shared.dashboardShell.recurringPayments"),
      contentWidthClass: "max-w-none",
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
  if (pathname.startsWith("/dashboard/payments/")) {
    const action = getPaymentsActions(t).find((item) => pathname.startsWith(item.href));
    const centeredTitle = action
      ? action.label
      : pathname.endsWith("/receive")
        ? t("Shared.dashboardShell.receive")
        : t("Shared.dashboardShell.send");

    return actionPageConfig({
      centeredTitle,
      backHref: "/dashboard/payments",
      backLabel: t("Shared.dashboardShell.backToPayments"),
      contentWidthClass: "max-w-none",
    });
  }
  if (pathname.startsWith("/dashboard/members")) {
    return { title: t("Shared.dashboardShell.members") };
  }
  if (pathname.startsWith("/dashboard/settings")) {
    return { title: t("Shared.dashboardShell.settings") };
  }
  if (pathname.startsWith("/dashboard/allowlist")) {
    return { title: t("Shared.dashboardShell.allowlist") };
  }
  return { title: t("Shared.dashboardShell.home") };
}

function ApiKeyNewLoading() {
  return <ApiKeyAuthoringSkeleton route="api-key-new" />;
}

function ApiKeyEditLoading() {
  return <ApiKeyAuthoringSkeleton route="api-key-edit" />;
}

function MembersLoading() {
  return <CompactOperationsCardSkeleton route="members" />;
}

function AllowlistLoading() {
  return <CompactOperationsCardSkeleton route="allowlist" />;
}

function resolvePageLoadingComponent(route: DashboardLoadingRoute): React.ComponentType {
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
    case "payments-pay":
      return PaymentsPayPageSkeleton;
    case "payments-deposit":
      return PaymentsDepositPageSkeleton;
    case "payment-requests":
      return PaymentRequestsPageSkeleton;
    case "counterparty-directory":
      return CounterpartyDirectorySkeleton;
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
    case "members":
      return MembersLoading;
    case "settings":
      return SettingsPageSkeleton;
    case "allowlist":
      return AllowlistLoading;
  }
}

function isItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  if (href === "/dashboard/wallets") {
    return pathname.startsWith("/dashboard/wallets") || pathname.startsWith("/dashboard/custody");
  }
  if (href === "/dashboard/payments") {
    if (pathname.startsWith("/dashboard/payments/counterparty")) return false;
    return pathname === "/dashboard/payments";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

const navItemBase =
  "relative flex h-10 items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-base transition-colors";
const navItemActive = "border border-border-subtle bg-white text-primary";
const navItemInactive = "text-secondary hover:bg-fill-strong hover:text-primary";

function SidebarGroup({
  title,
  items,
  pathname,
  onNavigate,
  isCollapsed,
  showTopSeparator,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
  isCollapsed: boolean;
  showTopSeparator: boolean;
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
        {items.map((item) => {
          const Icon = item.icon;
          const active = isItemActive(pathname, item.href);

          return (
            <div key={item.label}>
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
                  isCollapsed && "justify-center"
                )}
              >
                <Icon className="h-5 w-5 shrink-0" strokeWidth={1.9} />
                {isCollapsed ? null : (
                  <>
                    <span className="whitespace-nowrap">{item.label}</span>
                    {item.badge ? (
                      <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium text-white">
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    ) : null}
                  </>
                )}
                {isCollapsed && item.badge ? (
                  <span
                    className="absolute top-1 right-1 size-2 rounded-full border border-white bg-primary"
                    aria-hidden="true"
                  />
                ) : null}
              </DashboardNavigationLink>
              {!isCollapsed && item.children && item.children.length > 0 && (
                <div className="ml-5 mt-2">
                  {item.children.map((child, i, siblings) => {
                    const childActive = isItemActive(pathname, child.href);
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
                          <span className="flex h-9 flex-1 cursor-not-allowed items-center rounded-lg px-3 text-sm text-tertiary">
                            {child.label}
                            <LockIcon className="ml-auto h-3 w-3" />
                          </span>
                        ) : (
                          <DashboardNavigationLink
                            href={child.href}
                            onClick={onNavigate}
                            className={cn(
                              "flex h-9 flex-1 items-center rounded-lg px-3 text-sm transition-colors",
                              childActive ? navItemActive : navItemInactive
                            )}
                          >
                            {child.label}
                          </DashboardNavigationLink>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
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
}: {
  bottomNavItems: NavItem[];
  navSections: NavSection[];
  pathname: string;
  onNavigate?: () => void;
  onClose: () => void;
  isCollapsed: boolean;
  variant: "desktop" | "mobile";
  onOrganizationSwitchingChange: (isSwitching: boolean) => void;
}) {
  const t = useTranslations();
  const showMobileClose = variant === "mobile";
  return (
    <>
      <div className="space-y-6 p-3">
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
          />
        ))}
      </div>
      <div className="space-y-0.5 px-3 pb-1">
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
      </div>
    </>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this shell intentionally coordinates route-specific dashboard layout behavior in one place.
export function DashboardShell({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const pathname = usePathname();
  const { dashboardAccess, selectedProjectId, isSidebarOpen, setSidebarOpen, isProjectSwitching } =
    useDashboardWorkspace();
  const [isMobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{
    fromPathname: string;
    toPathname: string;
  } | null>(null);
  const [pendingApprovalCount, setPendingApprovalCount] = useState<number | null>(null);
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
  const pageConfig = getDashboardPageConfig(shellPathname, t);
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
    <HeaderBackAction href={pageConfig.backAction.href} label={pageConfig.backAction.label} />
  ) : null;
  const headerNav = pageConfig.headerNav;
  const centeredTitle = pageConfig.centeredTitle;
  const topBarLeadingContent = pageConfig.topBarLeadingContent;
  const shouldRenderHeaderNavRow =
    pageConfig.showHeaderNavRow || Boolean(backAction) || Boolean(headerNav);
  const shouldRenderTopBarBorder = Boolean(centeredTitle) && !shouldRenderHeaderNavRow;
  const shouldClipHorizontalOverflow =
    shellPathname === "/dashboard/payments" ||
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
  const shouldUseWorkspaceViewport =
    shellPathname === "/dashboard/issuance" ||
    shellPathname === "/dashboard/issuance/create" ||
    shellPathname === "/dashboard/policies" ||
    shellPathname === "/dashboard/api-keys/new" ||
    (shellPathname.startsWith("/dashboard/api-keys/") && shellPathname.endsWith("/edit")) ||
    shellPathname === "/dashboard/payments" ||
    shellPathname === "/dashboard/wallets" ||
    shellPathname === "/dashboard/custody" ||
    isWalletSetupRoute ||
    shellPathname === "/dashboard/payments/counterparty" ||
    (shellPathname.startsWith("/dashboard/payments/counterparty/") &&
      shellPathname !== "/dashboard/payments/counterparty/create") ||
    shellPathname === "/dashboard/payments/requests" ||
    shellPathname === "/dashboard/payments/recurring" ||
    shellPathname.startsWith("/dashboard/approvals") ||
    isWalletDetailRoute;
  const shouldLockViewportScroll = shouldUseWorkspaceViewport;
  const shouldLockShellViewport = shouldLockViewportScroll || isMobileSidebarOpen;

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

  if (!isLoaded) {
    return (
      <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-primary">
        <div className="mx-auto max-w-5xl border border-border-subtle bg-white/70 p-6">
          <p className="text-sm text-tertiary">{t("Shared.dashboardShell.loadingDashboard")}</p>
        </div>
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-primary">
        <div className="mx-auto max-w-3xl border border-border-subtle bg-white/70 p-6">
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
                className="inline-flex h-10 items-center justify-center rounded-[var(--button-radius-lg)] bg-primary px-[18px] text-[15px] font-semibold leading-[15px] text-white transition hover:opacity-90"
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
      <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-primary">
        <div className="mx-auto max-w-3xl border border-border-subtle bg-white/70 p-6">
          <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
            {t("Shared.dashboardShell.selectOrganization")}
          </h1>
          <p className="mt-3 text-sm text-tertiary">
            {t("Shared.dashboardShell.selectOrganizationDescription")}
          </p>
          <div className="mt-6">
            <OrganizationSwitcher hidePersonal />
          </div>
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
          "lg:grid-cols-[auto_1fr]",
        ].join(" ")}
      >
        <aside
          style={{ width: isSidebarOpen ? sidebarExpandedWidth : sidebarCollapsedWidth }}
          className="relative z-10 hidden bg-[var(--sdp-shell-bg)] lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:justify-between"
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
          />
          <button
            type="button"
            onClick={() => setSidebarOpen(!isSidebarOpen)}
            aria-label={
              isSidebarOpen
                ? t("Shared.dashboardShell.collapseSidebar")
                : t("Shared.dashboardShell.expandSidebar")
            }
            className="group absolute top-1/2 right-0 z-10 flex h-24 w-5 -translate-y-1/2 translate-x-3/4 cursor-pointer items-center justify-center"
          >
            <span className="block h-8 w-0.5 rounded-full bg-border-strong group-hover:bg-tertiary" />
          </button>
        </aside>

        {isMobileSidebarOpen ? (
          <div className="fixed inset-0 z-50 flex lg:hidden">
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
              />
            </div>
          </div>
        ) : null}

        <section
          className={[
            "relative min-w-0 rounded-2xl border border-border-subtle bg-white/80 lg:rounded-tl-[16px]",
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
              {shouldRenderTopBarBorder ? (
                <div
                  className={[
                    "border-b border-border-default pb-4",
                    shouldLockViewportScroll
                      ? "px-3 pt-5 md:px-6 md:pt-6"
                      : "-mx-3 px-3 md:-mx-6 md:px-6",
                  ].join(" ")}
                >
                  <DashboardTopBar
                    isMobileSidebarOpen={isMobileSidebarOpen}
                    setMobileSidebarOpen={setMobileSidebarOpen}
                    hideTitle={pageConfig.hideTitle}
                    title={pageConfig.title}
                    centeredTitle={centeredTitle}
                    topBarLeadingContent={topBarLeadingContent}
                  />
                </div>
              ) : (
                <div className={shouldLockViewportScroll ? "px-3 pt-5 md:px-6 md:pt-6" : ""}>
                  <DashboardTopBar
                    isMobileSidebarOpen={isMobileSidebarOpen}
                    setMobileSidebarOpen={setMobileSidebarOpen}
                    hideTitle={pageConfig.hideTitle}
                    title={pageConfig.title}
                    centeredTitle={centeredTitle}
                    topBarLeadingContent={topBarLeadingContent}
                  />
                </div>
              )}

              {shouldRenderHeaderNavRow ? (
                <div
                  className={[
                    "border-b border-border-default",
                    shouldLockViewportScroll ? "" : "-mx-3 md:-mx-6",
                  ].join(" ")}
                >
                  <div
                    className={[
                      "px-3 md:px-6",
                      backAction && headerNav
                        ? "grid min-h-[56px] grid-cols-[1fr_auto_1fr] items-center"
                        : backAction
                          ? "flex min-h-[56px] items-start pt-1"
                          : "flex min-h-[56px] items-end",
                    ].join(" ")}
                  >
                    {backAction && headerNav ? (
                      <>
                        <div className="flex items-center justify-start">{backAction}</div>
                        <div className="flex items-center justify-center">{headerNav}</div>
                        <div />
                      </>
                    ) : (
                      (backAction ?? headerNav)
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <div
              data-dashboard-page-content={isNavigationPending ? undefined : ""}
              className={[
                "mx-auto min-w-0 w-full",
                contentWidthClass,
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
                  <PageLoadingComponent />
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
