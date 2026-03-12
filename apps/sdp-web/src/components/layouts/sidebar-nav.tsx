"use client";

import {
  BookOpen,
  Coins,
  Home,
  KeyRound,
  PanelLeft,
  Send,
  Settings2,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

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

function isItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
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
      className={cn(
        "flex h-12 items-center gap-3 rounded-[12px] p-3 text-[16px] font-[550] leading-[24px] transition-colors",
        active
          ? "border border-[rgba(28,28,29,0.04)] bg-white text-[rgba(28,28,29,0.88)]"
          : "text-[rgba(28,28,29,0.72)] hover:bg-[rgba(28,28,29,0.04)] hover:text-[rgba(28,28,29,0.88)]"
      )}
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

interface OrgSwitcherPillProps {
  orgName: string;
  orgImageUrl?: string;
  onClick?: () => void;
}

function OrgSwitcherPill({ orgName, orgImageUrl, onClick }: OrgSwitcherPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[10px] border border-[rgba(28,28,29,0.08)] bg-white py-2 pr-3 pl-2 shadow-[0px_1px_3px_rgba(0,0,0,0.1),inset_0px_-1px_0px_rgba(0,0,0,0.1)] transition-colors hover:bg-[rgba(255,255,255,0.9)]"
    >
      {orgImageUrl ? (
        <Image
          src={orgImageUrl}
          alt={orgName}
          width={28}
          height={28}
          className="rounded-[6px]"
        />
      ) : (
        <div className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-[rgba(28,28,29,0.08)]">
          <span className="text-[12px] font-semibold text-[rgba(28,28,29,0.48)]">
            {orgName.charAt(0).toUpperCase()}
          </span>
        </div>
      )}
      <span className="min-w-0 flex-1 truncate text-left text-[16px] leading-[24px] font-[550] text-black">
        {orgName}
      </span>
      <svg
        className="h-6 w-6 shrink-0 text-[rgba(28,28,29,0.56)]"
        viewBox="0 0 24 24"
        fill="none"
      >
        <path
          d="M6 9l6 6 6-6"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

interface UserProfileRowProps {
  userName: string;
  userImageUrl?: string;
  onUserClick?: () => void;
}

function UserProfileRow({ userName, userImageUrl, onUserClick }: UserProfileRowProps) {
  const content = (
    <>
      {userImageUrl ? (
        <Image
          src={userImageUrl}
          alt={userName}
          width={20}
          height={20}
          className="shrink-0 rounded-full"
        />
      ) : (
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgba(28,28,29,0.12)]">
          <span className="text-[9px] font-semibold text-[rgba(28,28,29,0.48)]">
            {userName.charAt(0).toUpperCase()}
          </span>
        </div>
      )}
      <span className="min-w-0 truncate text-[16px] font-[550] leading-[24px] text-[rgba(28,28,29,0.72)]">
        {userName}
      </span>
    </>
  );

  if (onUserClick) {
    return (
      <button
        type="button"
        onClick={onUserClick}
        className="flex h-12 w-full items-center gap-3 rounded-[12px] p-3 transition-colors hover:bg-[rgba(28,28,29,0.04)]"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex h-12 items-center gap-3 rounded-[12px] p-3">
      {content}
    </div>
  );
}

export interface SidebarNavProps {
  orgName: string;
  orgImageUrl?: string;
  userName: string;
  userImageUrl?: string;
  onOrgClick?: () => void;
  onUserClick?: () => void;
  onCollapse?: () => void;
  className?: string;
}

export function SidebarNav({
  orgName,
  orgImageUrl,
  userName,
  userImageUrl,
  onOrgClick,
  onUserClick,
  onCollapse,
  className,
}: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        "flex w-[272px] shrink-0 flex-col justify-between bg-[#e9e7de]",
        className
      )}
    >
      {/* Top: org switcher + nav sections */}
      <div className="flex flex-col gap-8 p-8">
        {/* Org switcher row */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <OrgSwitcherPill
              orgName={orgName}
              orgImageUrl={orgImageUrl}
              onClick={onOrgClick}
            />
          </div>
          {onCollapse && (
            <button
              type="button"
              aria-label="Close navigation"
              onClick={onCollapse}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[rgba(28,28,29,0.72)] transition-colors hover:bg-[rgba(28,28,29,0.08)]"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Nav sections */}
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
      <div className="flex flex-col">
        <div className="flex flex-col gap-2 p-8">
          {bottomNavItems.map((item) => (
            <NavItemLink key={item.label} item={item} pathname={pathname} />
          ))}
          {/* Divider */}
          <div className="h-[1.5px] bg-[rgba(28,28,29,0.04)]" />
          {/* User profile row */}
          <UserProfileRow userName={userName} userImageUrl={userImageUrl} onUserClick={onUserClick} />
        </div>
        {/* Bottom border */}
        <div className="h-px bg-[rgba(28,28,29,0.12)]" />
      </div>
    </nav>
  );
}
