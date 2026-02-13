"use client";

import { OrganizationSwitcher, SignInButton, UserButton, useAuth } from "@clerk/nextjs";
import {
  ArrowLeftRight,
  ChevronDown,
  Coins,
  KeyRound,
  LayoutDashboard,
  PanelLeft,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

const createNav: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Wallets", href: "/dashboard/wallets", icon: Wallet },
];

const manageNav: NavItem[] = [
  { label: "Issuance", href: "/dashboard/issuance", icon: Coins },
  { label: "Payments", href: "/dashboard/payments", icon: ArrowLeftRight },
  { label: "API keys", href: "/dashboard/api-keys", icon: KeyRound },
];

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
      <div className="space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isItemActive(pathname, item.href);

          return (
            <Link
              key={item.label}
              href={item.href}
              className={[
                "flex h-11 items-center gap-3 rounded-[10px] px-3 text-[16px] leading-[24px] transition-colors",
                active
                  ? "bg-[rgba(28,28,29,0.10)] text-[#1c1c1d]"
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

  if (!isLoaded) {
    return (
      <main className="min-h-screen bg-[#e9e7de] px-4 py-4 text-[#1c1c1d] md:px-6">
        <div className="mx-auto max-w-5xl rounded-2xl border border-[rgba(28,28,29,0.08)] bg-white/70 p-8">
          <p className="text-sm text-[rgba(28,28,29,0.56)]">Loading dashboard...</p>
        </div>
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="min-h-screen bg-[#e9e7de] px-4 py-4 text-[#1c1c1d] md:px-6">
        <div className="mx-auto max-w-3xl rounded-2xl border border-[rgba(28,28,29,0.08)] bg-white/70 p-8">
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
      <main className="min-h-screen bg-[#e9e7de] px-4 py-4 text-[#1c1c1d] md:px-6">
        <div className="mx-auto max-w-3xl rounded-2xl border border-[rgba(28,28,29,0.08)] bg-white/70 p-8">
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
    <main className="min-h-screen bg-[#e9e7de] px-4 py-4 text-[#1c1c1d] md:px-6">
      <div className="mx-auto grid max-w-[1520px] gap-3 lg:grid-cols-[296px_1fr]">
        <header className="col-span-full flex h-14 items-center justify-between rounded-[12px] border border-[rgba(28,28,29,0.08)] bg-[rgba(255,255,255,0.75)] px-3 backdrop-blur-sm md:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/dashboard" aria-label="Go to dashboard">
              <Image src="/landing/solana-logo.svg" alt="Solana" width={18} height={16} />
            </Link>
            <div className="hidden items-center gap-3 md:flex">
              <OrganizationSwitcher hidePersonal />
              <span className="text-[rgba(28,28,29,0.36)]">/</span>
              <span className="text-sm text-[rgba(28,28,29,0.72)]">Default project</span>
            </div>
          </div>

          <div className="flex items-center gap-3 md:gap-5">
            <nav className="hidden items-center gap-5 md:flex">
              <Link href="#" className="text-sm text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
                API Docs
              </Link>
            </nav>
            <UserButton />
          </div>
        </header>

        <aside className="hidden h-[calc(100vh-96px)] rounded-[16px] border border-[rgba(28,28,29,0.12)] bg-[rgba(255,255,255,0.74)] p-4 lg:flex lg:flex-col">
          <div className="space-y-8">
            <div className="relative overflow-hidden rounded-[10px] border border-[rgba(28,28,29,0.16)] bg-white px-2 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
              <div className="mb-3 flex items-center justify-between pl-1 pr-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-white">
                    <Image
                      src="/landing/solana-logo.svg"
                      alt=""
                      width={18}
                      height={18}
                      className="h-4 w-4"
                    />
                  </div>
                  <p className="truncate text-[16px] font-medium">Ramp</p>
                </div>
                <ChevronDown className="h-4 w-4 text-[rgba(28,28,29,0.56)]" />
              </div>
              <div className="flex items-center justify-end">
                <PanelLeft className="h-5 w-5 text-[rgba(28,28,29,0.56)]" />
              </div>
            </div>
            <SidebarGroup title="Create" items={createNav} pathname={pathname} />
            <SidebarGroup title="Manage" items={manageNav} pathname={pathname} />
          </div>
        </aside>

        <section className="relative min-h-[calc(100vh-96px)] rounded-[24px] border border-[rgba(28,28,29,0.08)] bg-[rgba(255,255,255,0.7)] px-4 py-8 md:p-7">
          <div className="pointer-events-none absolute left-8 top-8 hidden h-11 items-center gap-2 rounded-[10px] border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-3 py-2 text-sm md:inline-flex">
            <span className="text-[rgba(28,28,29,0.72)]">Default Project</span>
            <ChevronDown className="h-4 w-4 text-[rgba(28,28,29,0.72)]" />
          </div>
          {children}
        </section>
      </div>
    </main>
  );
}
