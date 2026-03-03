"use client";

import { CreateApiKeyModal } from "@/app/dashboard/api-keys/create-api-key-modal";
import { CreateIssuanceTokenModal } from "@/app/dashboard/issuance/create-token-modal";
import { IssuanceApiKeySelector } from "@/app/dashboard/issuance/issuance-api-key-selector";
import { DashboardQuickActions } from "@/components/dashboard-quick-actions";
import { IssuanceHeaderTabs } from "@/components/issuance-header-tabs";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { OrganizationSwitcher, SignInButton, UserButton, useAuth } from "@clerk/nextjs";
import { motion } from "framer-motion";
import {
  ArrowLeftRight,
  ChevronDown,
  Coins,
  KeyRound,
  LayoutDashboard,
  Library,
  PanelLeft,
  PanelRight,
  Settings2,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  external?: boolean;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const navSections: NavSection[] = [
  {
    title: "Create",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "Wallets", href: "/dashboard/wallets", icon: Wallet },
    ],
  },
  {
    title: "Manage",
    items: [
      { label: "Issuance", href: "/dashboard/issuance", icon: Coins },
      { label: "Payments", href: "/dashboard/payments", icon: ArrowLeftRight },
      { label: "API keys", href: "/dashboard/api-keys", icon: KeyRound },
    ],
  },
];

const docsHref =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:3001/docs"
    : "https://platform.solana.com/docs");

const bottomNavItems: NavItem[] = [
  { label: "API Docs", href: docsHref, icon: Library, external: true },
  { label: "Settings", href: "/dashboard/settings", icon: Settings2 },
];

type DashboardPageConfig = {
  title: string;
  quickActionsLeft?: ReactNode;
  quickActionsRight?: ReactNode;
  contentWidthClass?: string;
};

function WalletQuickAction() {
  return (
    <Link href="/dashboard/wallets/setup">
      <button
        type="button"
        className="inline-flex h-10 items-center justify-center rounded-md bg-[#1c1c1d] px-4 text-sm font-medium text-white hover:bg-[rgba(28,28,29,0.92)]"
      >
        New wallet
      </button>
    </Link>
  );
}

function getDashboardPageConfig(pathname: string): DashboardPageConfig {
  if (pathname === "/dashboard") {
    return { title: "Dashboard" };
  }
  if (pathname === "/dashboard/wallets" || pathname === "/dashboard/custody") {
    return {
      title: "Wallets",
      quickActionsRight: <WalletQuickAction />,
    };
  }
  if (pathname === "/dashboard/wallets/setup" || pathname === "/dashboard/custody/setup") {
    return { title: "Activate provider", contentWidthClass: "max-w-3xl" };
  }
  if (pathname === "/dashboard/wallets/switch" || pathname === "/dashboard/custody/switch") {
    return { title: "Activate provider", contentWidthClass: "max-w-3xl" };
  }
  if (pathname === "/dashboard/api-keys") {
    return {
      title: "API keys",
      quickActionsRight: <CreateApiKeyModal triggerMode="button" triggerLabel="Create API key" />,
    };
  }
  if (pathname.startsWith("/dashboard/issuance")) {
    return {
      title: "Issuance",
      quickActionsLeft: <IssuanceHeaderTabs />,
      quickActionsRight: (
        <>
          <IssuanceApiKeySelector />
          <CreateIssuanceTokenModal />
        </>
      ),
    };
  }
  if (pathname.startsWith("/dashboard/payments")) {
    return {
      title: "Payments",
      quickActionsLeft: <IssuanceHeaderTabs />,
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
  return { title: "Dashboard" };
}

function isItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  if (href === "/dashboard/wallets") {
    return pathname.startsWith("/dashboard/wallets") || pathname.startsWith("/dashboard/custody");
  }
  return pathname.startsWith(href);
}

function SidebarGroup({
  title,
  items,
  pathname,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
}) {
  return (
    <div className="space-y-2">
      <p className="px-3 text-[12px] uppercase tracking-[0.4px] text-[rgba(28,28,29,0.48)]">
        {title}
      </p>
      <div className="space-y-0.5">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isItemActive(pathname, item.href);

          return (
            <Link
              key={item.label}
              href={item.href}
              className={[
                "flex h-10 items-center gap-3 rounded-[10px] px-3 text-[16px] leading-[24px] transition-colors",
                active
                  ? "border border-[rgba(28,28,29,0.08)] bg-white text-[#1c1c1d]"
                  : "text-[rgba(28,28,29,0.76)] hover:bg-[rgba(28,28,29,0.06)] hover:text-[#1c1c1d]",
              ].join(" ")}
            >
              <Icon className="h-5 w-5" strokeWidth={1.9} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const pathname = usePathname();
  const { isSidebarOpen, selectedProject, setSidebarOpen } = useDashboardWorkspace();
  const sidebarWidth = 296;
  const pageConfig = getDashboardPageConfig(pathname);
  const contentWidthClass = pageConfig.contentWidthClass ?? "max-w-5xl";

  if (!isLoaded) {
    return (
      <main className="min-h-screen bg-[#e9e7de] p-0 text-[#1c1c1d]">
        <div className="mx-auto max-w-5xl border border-[rgba(28,28,29,0.08)] bg-white/70 p-6">
          <p className="text-sm text-[rgba(28,28,29,0.56)]">Loading dashboard...</p>
        </div>
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="min-h-screen bg-[#e9e7de] p-0 text-[#1c1c1d]">
        <div className="mx-auto max-w-3xl border border-[rgba(28,28,29,0.08)] bg-white/70 p-6">
          <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
            Sign in to continue
          </h1>
          <p className="mt-3 text-sm text-[rgba(28,28,29,0.64)]">
            Access your organization workspace and wallet controls.
          </p>
          <div className="mt-6">
            <SignInButton mode="modal">
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center rounded-[10px] bg-[#0f0f10] px-[18px] text-[15px] font-semibold leading-[15px] text-white transition-colors hover:bg-black"
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
      <main className="min-h-screen bg-[#e9e7de] p-0 text-[#1c1c1d]">
        <div className="mx-auto max-w-3xl border border-[rgba(28,28,29,0.08)] bg-white/70 p-6">
          <h1 className="text-[34px] leading-[1.05] font-medium tracking-[-0.3px]">
            Select an organization
          </h1>
          <p className="mt-3 text-sm text-[rgba(28,28,29,0.64)]">
            You need an organization to continue.
          </p>
          <div className="mt-6">
            <OrganizationSwitcher hidePersonal />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#e9e7de] p-0 text-[#1c1c1d]">
      <div
        className={[
          "mx-auto grid min-h-screen w-full max-w-none gap-0",
          "lg:grid-cols-[auto_1fr]",
        ].join(" ")}
      >
        <motion.aside
          initial={false}
          animate={{ width: isSidebarOpen ? sidebarWidth : 0 }}
          transition={{ duration: 0.22, ease: "easeInOut" }}
          style={{ pointerEvents: isSidebarOpen ? "auto" : "none" }}
          className={[
            "hidden overflow-hidden border border-[rgba(28,28,29,0.10)] border-r-0 bg-[#e9e7de] lg:flex lg:flex-col lg:justify-between",
          ].join(" ")}
        >
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
                  onClick={() => setSidebarOpen(false)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[rgba(28,28,29,0.72)] transition-colors hover:bg-[rgba(28,28,29,0.08)]"
                  whileHover={{ scale: 1.05, rotate: -3 }}
                  whileTap={{ scale: 0.95, rotate: -10 }}
                >
                  <motion.div
                    initial={{ rotate: -10 }}
                    animate={{ rotate: 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    <PanelLeft className="h-5 w-5" />
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
              />
            ))}
          </div>
          <div className="space-y-2 pb-1">
            {bottomNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  target={item.external ? "_blank" : undefined}
                  rel={item.external ? "noopener noreferrer" : undefined}
                  className="flex h-10 items-center gap-3 rounded-[10px] px-3 text-[16px] leading-[24px] text-[rgba(28,28,29,0.76)] transition-colors hover:bg-[rgba(28,28,29,0.06)] hover:text-[#1c1c1d]"
                >
                  <Icon className="h-5 w-5" strokeWidth={1.9} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </motion.aside>

        <section className="relative rounded-[16px] border border-[rgba(28,28,29,0.08)] bg-[rgba(255,255,255,0.8)] px-3 py-5 md:p-6 lg:rounded-tl-[16px]">
          <div className={["mx-auto w-full", contentWidthClass].join(" ")}>
            <div className="mb-6 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  {!isSidebarOpen ? (
                    <motion.button
                      type="button"
                      aria-label="Open navigation"
                      onClick={() => setSidebarOpen(true)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[rgba(28,28,29,0.72)] transition-colors hover:bg-[rgba(28,28,29,0.08)]"
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.93, rotate: 8 }}
                    >
                      <motion.div
                        initial={{ rotate: 10 }}
                        animate={{ rotate: 0 }}
                        transition={{ duration: 0.18 }}
                      >
                        <PanelRight className="h-4 w-4" />
                      </motion.div>
                    </motion.button>
                  ) : null}
                  <h1 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">
                    {pageConfig.title}
                  </h1>
                  <div className="pointer-events-none hidden h-10 items-center gap-2 rounded-[10px] border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-3 py-2 text-sm md:flex">
                    <span className="text-[rgba(28,28,29,0.72)]">{selectedProject}</span>
                    <ChevronDown className="h-4 w-4 text-[rgba(28,28,29,0.72)]" />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <UserButton afterSignOutUrl="/sign-in" />
                </div>
              </div>

              <DashboardQuickActions
                left={pageConfig.quickActionsLeft}
                right={pageConfig.quickActionsRight}
              />
            </div>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}
