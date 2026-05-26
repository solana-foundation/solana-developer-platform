"use client";

import { OrganizationSwitcher, SignInButton, UserButton, useAuth } from "@clerk/nextjs";
import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  CoinsIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  LockIcon,
  PanelLeftIcon,
  PanelRightIcon,
  Settings2Icon,
  WalletIcon,
} from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CounterpartyHeaderTabs } from "@/components/counterparty-header-tabs";
import { IssuanceHeaderTabs } from "@/components/issuance-header-tabs";
import { NetworkDebugPanel, NetworkDebugToggle } from "@/components/network-debug-panel";
import { SentryFeedbackWidget } from "@/components/sentry-feedback-widget";
import { SentryUserContext } from "@/components/sentry-user-context";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
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
  external?: boolean;
  children?: SubNavItem[];
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const navSections: NavSection[] = [
  {
    title: "Create",
    items: [
      { label: "Home", href: "/dashboard", icon: LayoutDashboardIcon },
      { label: "Wallets", href: "/dashboard/wallets", icon: WalletIcon },
    ],
  },
  {
    title: "Manage",
    items: [
      { label: "Issuance", href: "/dashboard/issuance", icon: CoinsIcon },
      {
        label: "Payments",
        href: "/dashboard/payments",
        icon: ArrowLeftRightIcon,
        children: [
          { label: "Counterparty", href: "/dashboard/payments/counterparty" },
          { label: "Pay", href: "/dashboard/pay", disabled: true },
          { label: "Deposit", href: "/dashboard/deposit", disabled: true },
        ],
      },
      { label: "API keys", href: "/dashboard/api-keys", icon: KeyRoundIcon },
    ],
  },
];

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
  isSidebarOpen: boolean;
  setSidebarOpen: (value: boolean) => void;
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
    <Link
      href={href}
      className="inline-flex h-7 items-center gap-1.5 rounded-[var(--button-radius-md)] text-text-medium transition-colors hover:text-text-extra-high"
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
  isSidebarOpen,
  setSidebarOpen,
  isMobileSidebarOpen,
  setMobileSidebarOpen,
}: {
  isSidebarOpen: boolean;
  setSidebarOpen: (value: boolean) => void;
  isMobileSidebarOpen: boolean;
  setMobileSidebarOpen: (value: boolean) => void;
}) {
  return (
    <>
      <motion.button
        type="button"
        aria-label="Open navigation"
        onClick={() => setMobileSidebarOpen(true)}
        className={[
          "inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-medium transition-colors hover:bg-border-light lg:hidden",
          isMobileSidebarOpen ? "invisible" : "",
        ].join(" ")}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.93, rotate: 8 }}
      >
        <motion.div
          initial={{ rotate: 10 }}
          animate={{ rotate: 0 }}
          transition={{ duration: 0.18 }}
        >
          <PanelRightIcon className="h-4 w-4" />
        </motion.div>
      </motion.button>
      {!isSidebarOpen ? (
        <motion.button
          type="button"
          aria-label="Open navigation"
          onClick={() => setSidebarOpen(true)}
          className="hidden h-8 w-8 items-center justify-center rounded-lg text-text-medium transition-colors hover:bg-border-light lg:inline-flex"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.93, rotate: 8 }}
        >
          <motion.div
            initial={{ rotate: 10 }}
            animate={{ rotate: 0 }}
            transition={{ duration: 0.18 }}
          >
            <PanelRightIcon className="h-4 w-4" />
          </motion.div>
        </motion.button>
      ) : null}
    </>
  );
}

function DashboardTopBar({
  isSidebarOpen,
  setSidebarOpen,
  isMobileSidebarOpen,
  setMobileSidebarOpen,
  hideTitle,
  title,
  centeredTitle,
  topBarLeadingContent,
}: DashboardTopBarProps) {
  const { sdpEnvironment } = useDashboardWorkspace();
  const isSandbox = sdpEnvironment === "sandbox";
  const sandboxBadge = isSandbox ? (
    <>
      <span aria-hidden="true" className="h-4 w-px bg-border-light" />
      <Badge>Sandbox</Badge>
    </>
  ) : null;

  if (centeredTitle) {
    return (
      <div className="grid min-h-[40px] grid-cols-[1fr_auto_1fr] items-start gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarToggle
            isSidebarOpen={isSidebarOpen}
            setSidebarOpen={setSidebarOpen}
            isMobileSidebarOpen={isMobileSidebarOpen}
            setMobileSidebarOpen={setMobileSidebarOpen}
          />
          {topBarLeadingContent}
        </div>
        <div className="flex items-start justify-center">
          <h1 className="text-center text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-text-extra-high">
            {centeredTitle}
          </h1>
        </div>
        <div className="flex items-center justify-end gap-2">
          <UserButton />
          {sandboxBadge}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <SidebarToggle
          isSidebarOpen={isSidebarOpen}
          setSidebarOpen={setSidebarOpen}
          isMobileSidebarOpen={isMobileSidebarOpen}
          setMobileSidebarOpen={setMobileSidebarOpen}
        />
        {hideTitle ? null : (
          <h1 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-text-extra-high">
            {title}
          </h1>
        )}
      </div>

      <div className="flex items-center gap-2">
        <UserButton />
        {sandboxBadge}
      </div>
    </div>
  );
}

function SandboxToggle() {
  const { sdpEnvironment } = useDashboardWorkspace();
  const isSandbox = sdpEnvironment === "sandbox";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block w-full">
            <button
              type="button"
              disabled
              aria-pressed={isSandbox}
              className="flex h-10 w-full cursor-not-allowed items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-[16px] leading-[24px] text-text-medium"
            >
              <span
                className={[
                  "relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors",
                  isSandbox
                    ? "border-text-extra-high bg-text-extra-high"
                    : "border-border-medium bg-border-medium",
                ].join(" ")}
                aria-hidden="true"
              >
                <span
                  className={[
                    "absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform",
                    isSandbox ? "translate-x-4.5" : "translate-x-0.5",
                  ].join(" ")}
                />
              </span>
              <span className="min-w-0 truncate text-left">Sandbox mode</span>
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" align="center" sideOffset={28} className="text-xs">
          Only Sandbox mode supported at the moment
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function getDashboardPageConfig(pathname: string): DashboardPageConfig {
  if (pathname === "/dashboard") {
    return {
      title: "Home",
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/wallets" || pathname === "/dashboard/custody") {
    return {
      title: "Wallets",
      headerNav: <IssuanceHeaderTabs />,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/wallets/setup" || pathname === "/dashboard/custody/setup") {
    return {
      title: "Activate provider",
      contentWidthClass: "max-w-3xl",
      backAction: {
        href: "/dashboard/wallets",
        label: "Back to wallets",
      },
    };
  }
  if (pathname === "/dashboard/wallets/switch" || pathname === "/dashboard/custody/switch") {
    return {
      title: "Activate provider",
      contentWidthClass: "max-w-3xl",
      backAction: {
        href: "/dashboard/wallets",
        label: "Back to wallets",
      },
    };
  }
  if (
    (pathname.startsWith("/dashboard/wallets/") && pathname !== "/dashboard/wallets/setup") ||
    (pathname.startsWith("/dashboard/custody/") && pathname !== "/dashboard/custody/setup")
  ) {
    return {
      title: "Wallets",
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/wallets",
        label: "Back to wallets",
      },
    };
  }
  if (pathname === "/dashboard/api-keys") {
    return {
      title: "API keys",
      showHeaderNavRow: true,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname === "/dashboard/issuance") {
    return {
      title: "Issuance",
      headerNav: <IssuanceHeaderTabs />,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname.startsWith("/dashboard/issuance/")) {
    return {
      title: "Issuance",
      contentWidthClass: "max-w-none",
      backAction: {
        href: "/dashboard/issuance",
        label: "Back to overview",
      },
    };
  }
  if (pathname === "/dashboard/payments/counterparty") {
    return {
      title: "Counterparty",
      headerNav: <CounterpartyHeaderTabs />,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname.startsWith("/dashboard/payments/counterparty/")) {
    return {
      title: "",
      hideTitle: true,
      showHeaderNavRow: true,
      centeredTitle: "New Counterparty",
      topBarLeadingContent: (
        <HeaderBackAction
          href="/dashboard/payments/counterparty"
          label="Back to Counterparty"
          compactOnMobile
        />
      ),
      contentWidthClass: "max-w-xl",
    };
  }
  if (pathname === "/dashboard/payments") {
    return {
      title: "Payments",
      headerNav: <IssuanceHeaderTabs />,
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname.startsWith("/dashboard/payments/")) {
    const actionTitle = pathname.endsWith("/receive") ? "Receive" : "Send";

    return {
      title: "",
      hideTitle: true,
      showHeaderNavRow: true,
      centeredTitle: actionTitle,
      topBarLeadingContent: (
        <HeaderBackAction href="/dashboard/payments" label="Back to payments" compactOnMobile />
      ),
      contentWidthClass: "max-w-none",
    };
  }
  if (pathname.startsWith("/dashboard/members")) {
    return { title: "Members" };
  }
  if (pathname.startsWith("/dashboard/settings")) {
    return { title: "Settings" };
  }
  if (pathname.startsWith("/dashboard/allowlist")) {
    return { title: "Allowlist" };
  }
  return { title: "Home" };
}

function isItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  if (href === "/dashboard/wallets") {
    return pathname.startsWith("/dashboard/wallets") || pathname.startsWith("/dashboard/custody");
  }
  if (href === "/dashboard/payments") {
    return (
      pathname.startsWith("/dashboard/payments") &&
      !pathname.startsWith("/dashboard/payments/counterparty")
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

const navItemBase =
  "flex items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-[16px] leading-[24px] transition-colors";
const navItemActive = "border border-border-extra-light bg-white text-text-extra-high";
const navItemInactive = "text-text-medium hover:bg-border-light hover:text-text-extra-high";

function SidebarGroup({
  title,
  items,
  pathname,
  onNavigate,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="px-3 text-[12px] uppercase tracking-[0.4px] text-text-extra-low">{title}</p>
      <div className="space-y-0.5">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isItemActive(pathname, item.href);

          return (
            <div key={item.label}>
              <Link
                href={item.href}
                onClick={onNavigate}
                className={cn(navItemBase, "h-10", active ? navItemActive : navItemInactive)}
              >
                <Icon className="h-5 w-5" strokeWidth={1.9} />
                <span>{item.label}</span>
              </Link>
              {item.children && item.children.length > 0 && (
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
                            childActive ? "bg-text-medium" : "bg-border-light"
                          )}
                        />
                        {child.disabled ? (
                          <span className="flex h-9 flex-1 cursor-not-allowed items-center rounded-lg px-3 text-sm text-text-low">
                            {child.label}
                            <LockIcon className="ml-auto h-3 w-3" />
                          </span>
                        ) : (
                          <Link
                            href={child.href}
                            onClick={onNavigate}
                            className={cn(
                              "flex h-9 flex-1 items-center rounded-lg px-3 text-sm transition-colors",
                              childActive ? navItemActive : navItemInactive
                            )}
                          >
                            {child.label}
                          </Link>
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
  pathname,
  onNavigate,
  onClose,
}: {
  bottomNavItems: NavItem[];
  pathname: string;
  onNavigate?: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="w-[296px] space-y-6 p-3">
        <div className="relative px-2 py-3">
          <div className="mb-2 flex items-center justify-between pl-1 pr-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <OrganizationSwitcher hidePersonal />
              </div>
            </div>
            <motion.button
              type="button"
              aria-label="Close navigation"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-medium transition-colors hover:bg-border-light"
              whileHover={{ scale: 1.05, rotate: -3 }}
              whileTap={{ scale: 0.95, rotate: -10 }}
            >
              <motion.div
                initial={{ rotate: -10 }}
                animate={{ rotate: 0 }}
                transition={{ duration: 0.18 }}
              >
                <PanelLeftIcon className="h-5 w-5" />
              </motion.div>
            </motion.button>
          </div>
        </div>
        {navSections.map((section) => (
          <SidebarGroup
            key={section.title}
            title={section.title}
            items={section.items}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}
        <div className="space-y-2">
          <p className="px-3 text-[12px] uppercase tracking-[0.4px] text-text-extra-low">Mode</p>
          <div className="space-y-0.5">
            <SandboxToggle />
            <NetworkDebugToggle />
          </div>
        </div>
      </div>
      <div className="space-y-0.5 pb-1">
        <SentryFeedbackWidget />
        {bottomNavItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              href={item.href}
              target={item.external ? "_blank" : undefined}
              rel={item.external ? "noopener noreferrer" : undefined}
              onClick={onNavigate}
              className="flex h-10 items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-[16px] leading-[24px] text-text-medium transition-colors hover:bg-border-light hover:text-text-extra-high"
            >
              <Icon className="h-5 w-5" strokeWidth={1.9} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this shell intentionally coordinates route-specific dashboard layout behavior in one place.
export function DashboardShell({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const pathname = usePathname();
  const { dashboardAccess, isSidebarOpen, setSidebarOpen } = useDashboardWorkspace();
  const [isMobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const previousPathnameRef = useRef(pathname);
  const sidebarWidth = 296;
  const pageConfig = getDashboardPageConfig(pathname);
  const bottomNavItems: NavItem[] = [
    { label: "API Docs", href: docsHref, icon: LibraryIcon, external: true },
    ...(dashboardAccess.capabilities.canManageOrgSettings
      ? [{ label: "Settings", href: "/dashboard/settings", icon: Settings2Icon }]
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
    pathname === "/dashboard/payments" ||
    (pathname.startsWith("/dashboard/payments/") &&
      !pathname.startsWith("/dashboard/payments/counterparty"));
  const shouldUseWorkspaceViewport =
    pathname === "/dashboard/issuance" ||
    pathname === "/dashboard/payments" ||
    pathname === "/dashboard/wallets" ||
    pathname === "/dashboard/custody" ||
    pathname === "/dashboard/payments/counterparty";
  const shouldLockViewportScroll = shouldUseWorkspaceViewport;
  const shouldLockShellViewport = shouldLockViewportScroll || isMobileSidebarOpen;

  useEffect(() => {
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      setMobileSidebarOpen(false);
    }
  }, [pathname]);

  if (!isLoaded) {
    return (
      <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-text-extra-high">
        <div className="mx-auto max-w-5xl border border-border-extra-light bg-white/70 p-6">
          <p className="text-sm text-text-low">Loading dashboard...</p>
        </div>
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-text-extra-high">
        <div className="mx-auto max-w-3xl border border-border-extra-light bg-white/70 p-6">
          <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
            Sign in to continue
          </h1>
          <p className="mt-3 text-sm text-text-low">
            Access your organization workspace and wallet controls.
          </p>
          <div className="mt-6">
            <SignInButton mode="modal">
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center rounded-[var(--button-radius-lg)] bg-gray-1400 px-[18px] text-[15px] font-semibold leading-[15px] text-white transition-colors hover:bg-black"
              >
                Sign in
              </button>
            </SignInButton>
          </div>
        </div>
      </main>
    );
  }

  if (!orgId) {
    return (
      <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-text-extra-high">
        <div className="mx-auto max-w-3xl border border-border-extra-light bg-white/70 p-6">
          <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
            Select an organization
          </h1>
          <p className="mt-3 text-sm text-text-low">You need an organization to continue.</p>
          <div className="mt-6">
            <OrganizationSwitcher hidePersonal />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      className={[
        "min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-text-extra-high",
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
        <motion.aside
          initial={false}
          animate={{ width: isSidebarOpen ? sidebarWidth : 0 }}
          transition={{ duration: 0.22, ease: "easeInOut" }}
          style={{ pointerEvents: isSidebarOpen ? "auto" : "none" }}
          className={[
            "hidden overflow-hidden border border-border-light border-r-0 bg-[var(--sdp-shell-bg)] lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:justify-between",
          ].join(" ")}
        >
          <DashboardSidebarContent
            bottomNavItems={bottomNavItems}
            pathname={pathname}
            onNavigate={undefined}
            onClose={() => setSidebarOpen(false)}
          />
        </motion.aside>

        {isMobileSidebarOpen ? (
          <div className="fixed inset-0 z-50 flex lg:hidden">
            <button
              type="button"
              aria-label="Close navigation overlay"
              className="absolute inset-0 bg-gray-1400/30"
              onClick={() => setMobileSidebarOpen(false)}
            />
            <div className="relative z-10 flex h-full w-[296px] max-w-[85vw] flex-col justify-between border-r border-border-light bg-[var(--sdp-shell-bg)] shadow-lg">
              <DashboardSidebarContent
                bottomNavItems={bottomNavItems}
                pathname={pathname}
                onNavigate={() => setMobileSidebarOpen(false)}
                onClose={() => setMobileSidebarOpen(false)}
              />
            </div>
          </div>
        ) : null}

        <section
          className={[
            "relative min-w-0 rounded-2xl border border-border-extra-light bg-white/80 lg:rounded-tl-[16px]",
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
                    "border-b border-border-light pb-4",
                    shouldLockViewportScroll
                      ? "px-3 pt-5 md:px-6 md:pt-6"
                      : "-mx-3 px-3 md:-mx-6 md:px-6",
                  ].join(" ")}
                >
                  <DashboardTopBar
                    isSidebarOpen={isSidebarOpen}
                    setSidebarOpen={setSidebarOpen}
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
                    isSidebarOpen={isSidebarOpen}
                    setSidebarOpen={setSidebarOpen}
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
                    "border-b border-border-light",
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
              className={[
                "mx-auto min-w-0 w-full",
                contentWidthClass,
                shouldClipHorizontalOverflow && !shouldLockViewportScroll
                  ? "overflow-x-hidden"
                  : "",
                shouldLockViewportScroll ? "min-h-0 flex-1 overflow-hidden" : "",
              ].join(" ")}
            >
              {children}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
