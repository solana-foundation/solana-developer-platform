"use client";

import { IssuanceHeaderTabs } from "@/components/issuance-header-tabs";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import {
  OrganizationSwitcher,
  SignInButton,
  UserButton,
  useAuth,
  useOrganization,
  useUser,
} from "@clerk/nextjs";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  BookOpen,
  Coins,
  Home,
  KeyRound,
  PanelLeft,
  PanelRight,
  Send,
  Settings2,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, type ReactNode } from "react";

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
      { label: "Home", href: "/dashboard", icon: Home },
      { label: "Wallets", href: "/dashboard/wallets", icon: Wallet },
    ],
  },
  {
    title: "Manage",
    items: [
      { label: "Issuance", href: "/dashboard/issuance", icon: Coins },
      { label: "Payments", href: "/dashboard/payments", icon: Send },
    ],
  },
];

const docsHref =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:3001/docs"
    : "https://platform.solana.com/docs");

const bottomNavItems: NavItem[] = [
  { label: "API keys", href: "/dashboard/api-keys", icon: KeyRound },
  { label: "Docs", href: docsHref, icon: BookOpen, external: true },
  { label: "Settings", href: "/dashboard/settings", icon: Settings2 },
];

type DashboardPageConfig = {
  title: string;
  headerNav?: ReactNode;
  showHeaderNavRow?: boolean;
  contentWidthClass?: string;
  backAction?: {
    href: string;
    label: string;
  };
};

function HeaderBackAction({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex h-7 items-center gap-1.5 rounded-[8px] text-[rgba(28,28,29,0.72)] transition-colors hover:text-[#1c1c1d]"
    >
      <ArrowLeft className="h-4 w-4" />
      <span className="text-[13px] leading-[18px] font-medium">{label}</span>
    </Link>
  );
}

function getDashboardPageConfig(pathname: string): DashboardPageConfig {
  if (pathname === "/dashboard") {
    return { title: "Home" };
  }
  if (pathname === "/dashboard/wallets" || pathname === "/dashboard/custody") {
    return {
      title: "Wallets",
      showHeaderNavRow: true,
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
  if (pathname.startsWith("/dashboard/payments")) {
    return {
      title: "Payments",
      headerNav: <IssuanceHeaderTabs />,
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
  return pathname.startsWith(href);
}

function NavItemLink({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string;
}) {
  const Icon = item.icon;
  const active = !item.external && isItemActive(pathname, item.href);

  return (
    <Link
      href={item.href}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noopener noreferrer" : undefined}
      className={[
        "flex h-12 items-center gap-3 rounded-[12px] border p-3 text-[16px] font-[550] leading-[24px] transition-colors",
        active
          ? "border-[rgba(28,28,29,0.04)] bg-white text-[rgba(28,28,29,0.88)]"
          : "border-transparent text-[rgba(28,28,29,0.72)] hover:bg-[rgba(28,28,29,0.04)] hover:text-[rgba(28,28,29,0.88)]",
      ].join(" ")}
    >
      <Icon className="h-5 w-5" strokeWidth={1.5} />
      <span>{item.label}</span>
    </Link>
  );
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
    <div className="flex flex-col gap-2">
      <p className="px-3 text-[12px] font-[550] leading-[18px] text-[rgba(28,28,29,0.56)]">
        {title}
      </p>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <NavItemLink key={item.label} item={item} pathname={pathname} />
        ))}
      </div>
    </div>
  );
}

function OrgSwitcherPill() {
  const { organization } = useOrganization();
  const switcherRef = useRef<HTMLDivElement>(null);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          const trigger = switcherRef.current?.querySelector("button");
          trigger?.click();
        }}
        className="flex w-full items-center gap-2 rounded-[10px] border border-[rgba(28,28,29,0.08)] bg-white py-2 pr-3 pl-2 shadow-[0px_1px_3px_rgba(0,0,0,0.1),inset_0px_-1px_0px_rgba(0,0,0,0.1)] transition-colors hover:bg-[rgba(255,255,255,0.9)]"
      >
        {organization?.imageUrl ? (
          <Image
            src={organization.imageUrl}
            alt={organization.name ?? ""}
            width={28}
            height={28}
            className="shrink-0 rounded-[6px]"
          />
        ) : (
          <div className="h-7 w-7 shrink-0 rounded-[6px] bg-[rgba(28,28,29,0.08)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-left text-[16px] leading-[24px] font-[550] text-black">
          {organization?.name ?? "Organization"}
        </span>
        <svg
          className="h-5 w-5 shrink-0 text-[rgba(28,28,29,0.48)]"
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div ref={switcherRef} className="absolute top-0 left-0 opacity-0 pointer-events-none [&>div]:pointer-events-auto [&>div]:opacity-100">
        <OrganizationSwitcher hidePersonal />
      </div>
    </div>
  );
}

function UserProfileRow() {
  const { user } = useUser();
  const userBtnRef = useRef<HTMLDivElement>(null);

  if (!user) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          const trigger = userBtnRef.current?.querySelector("button");
          trigger?.click();
        }}
        className="flex h-12 w-full items-center gap-3 rounded-[12px] p-3 transition-colors hover:bg-[rgba(28,28,29,0.04)]"
      >
        {user.imageUrl ? (
          <Image
            src={user.imageUrl}
            alt={user.fullName ?? ""}
            width={20}
            height={20}
            className="shrink-0 rounded-full"
          />
        ) : (
          <div className="h-5 w-5 shrink-0 rounded-full bg-[rgba(28,28,29,0.12)]" />
        )}
        <span className="min-w-0 truncate text-[16px] font-[550] leading-[24px] text-[rgba(28,28,29,0.72)]">
          {user.fullName}
        </span>
      </button>
      <div ref={userBtnRef} className="absolute top-0 left-0 opacity-0 pointer-events-none [&>div]:pointer-events-auto [&>div]:opacity-100">
        <UserButton afterSignOutUrl="/sign-in" />
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const pathname = usePathname();
  const { isSidebarOpen, issuanceTab, setSidebarOpen } = useDashboardWorkspace();
  const sidebarWidth = 296;
  const pageConfig = getDashboardPageConfig(pathname);
  const contentWidthClass = pageConfig.contentWidthClass ?? "max-w-5xl";
  const headerNav = pageConfig.backAction ? (
    <HeaderBackAction href={pageConfig.backAction.href} label={pageConfig.backAction.label} />
  ) : (
    pageConfig.headerNav
  );
  const shouldRenderHeaderNavRow = pageConfig.showHeaderNavRow || Boolean(headerNav);
  const shouldLockViewportScroll =
    issuanceTab === "playground" &&
    (pathname === "/dashboard/issuance" || pathname.startsWith("/dashboard/payments"));

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
    <main
      className={[
        "min-h-screen bg-[#e9e7de] p-0 text-[#1c1c1d]",
        shouldLockViewportScroll ? "h-screen overflow-hidden" : "",
      ].join(" ")}
    >
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
          className="hidden overflow-hidden border border-[rgba(28,28,29,0.10)] border-r-0 bg-[#e9e7de] lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:justify-between"
        >
          {/* Top: org switcher + nav sections */}
          <div className="flex w-[272px] flex-col gap-8 p-8">
            {/* Org switcher row */}
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <OrgSwitcherPill />
              </div>
              <motion.button
                type="button"
                aria-label="Close navigation"
                onClick={() => setSidebarOpen(false)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[rgba(28,28,29,0.72)] transition-colors hover:bg-[rgba(28,28,29,0.08)]"
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

            {/* Nav sections with gap-6 between them */}
            <div className="flex flex-col gap-6">
              {navSections.map((section) => (
                <SidebarGroup
                  key={section.title}
                  title={section.title}
                  items={section.items}
                  pathname={pathname}
                />
              ))}
            </div>
          </div>

          {/* Bottom: API keys, Docs, Settings, divider, user profile */}
          <div className="flex w-[272px] flex-col">
            <div className="flex flex-col gap-2 p-8">
              {bottomNavItems.map((item) => (
                <NavItemLink key={item.label} item={item} pathname={pathname} />
              ))}
              {/* Divider */}
              <div className="h-[1.5px] bg-[rgba(28,28,29,0.04)]" />
              {/* User profile row */}
              <UserProfileRow />
            </div>
            {/* Bottom border */}
            <div className="h-px bg-[rgba(28,28,29,0.12)]" />
          </div>
        </motion.aside>

        <section
          className={[
            "relative rounded-[16px] border border-[rgba(28,28,29,0.08)] bg-[rgba(255,255,255,0.8)] px-3 py-5 md:p-6 lg:rounded-tl-[16px]",
            shouldLockViewportScroll ? "flex min-h-0 flex-col overflow-hidden" : "",
          ].join(" ")}
        >
          <div
            className={[
              "w-full",
              shouldLockViewportScroll ? "flex min-h-0 flex-1 flex-col gap-0" : "space-y-6",
            ].join(" ")}
          >
            <div className="space-y-4">
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
                </div>

                <div className="flex items-center gap-2">
                  <UserButton afterSignOutUrl="/sign-in" />
                </div>
              </div>

              {shouldRenderHeaderNavRow ? (
                <div className="-mx-3 border-b border-[rgba(28,28,29,0.10)] md:-mx-6">
                  <div
                    className={[
                      "px-3 md:px-6",
                      pageConfig.backAction
                        ? "flex min-h-[56px] items-start pt-1"
                        : "flex min-h-[56px] items-end",
                    ].join(" ")}
                  >
                    {headerNav}
                  </div>
                </div>
              ) : null}
            </div>
            <div
              className={[
                "mx-auto w-full",
                contentWidthClass,
                shouldLockViewportScroll
                  ? "min-h-0 flex-1 overflow-hidden -mx-3 md:-mx-6 -mb-5 md:-mb-6"
                  : "",
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
