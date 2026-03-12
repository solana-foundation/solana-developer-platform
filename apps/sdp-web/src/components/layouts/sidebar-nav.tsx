"use client";

import { cn } from "@/lib/utils";
import {
  NavApiKeys,
  NavDocs,
  NavHome,
  NavIssuance,
  NavPayments,
  NavSettings,
  NavWallets,
  PanelLeft,
} from "@/components/ui/icons";
import type { LucideIcon, LucideProps } from "@/components/ui/icons";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  external?: boolean;
};

type NavSectionDensity = "default" | "compact";

type NavSection = {
  title: string;
  density: NavSectionDensity;
  items: NavItem[];
};

const navSections: NavSection[] = [
  {
    title: "Create",
    density: "default",
    items: [
      { label: "Home", href: "/dashboard", icon: NavHome },
      { label: "Wallets", href: "/dashboard/wallets", icon: NavWallets },
    ],
  },
  {
    title: "Manage",
    density: "compact",
    items: [
      { label: "Issuance", href: "/dashboard/issuance", icon: NavIssuance },
      { label: "Payments", href: "/dashboard/payments", icon: NavPayments },
    ],
  },
];

const docsHref =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:3001/docs"
    : "https://platform.solana.com/docs");

const bottomNavItems: NavItem[] = [
  { label: "API keys", href: "/dashboard/api-keys", icon: NavApiKeys },
  { label: "Docs", href: docsHref, icon: NavDocs, external: true },
  { label: "Settings", href: "/dashboard/settings", icon: NavSettings },
];

const sidebarIconProps: LucideProps = {
  className: "h-5 w-5 shrink-0",
  strokeWidth: 2.3,
};

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
      aria-current={active ? "page" : undefined}
      className={cn(
        "text-body-lg-bold flex h-[var(--layout-shell-nav-row-height)] w-full cursor-pointer items-center gap-[var(--layout-shell-nav-row-gap)] rounded-[var(--layout-shell-nav-row-radius)] border border-transparent p-[var(--layout-shell-nav-row-padding)] outline-none transition-[background-color,border-color,color,box-shadow] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.14)] motion-reduce:transition-none",
        active
          ? "border-border-extra-light bg-white text-text-high"
          : "text-text-medium hover:border-border-extra-light hover:bg-border-extra-light hover:text-text-high"
      )}
    >
      <Icon {...sidebarIconProps} />
      <span>{item.label}</span>
    </Link>
  );
}

function SidebarGroup({
  title,
  density,
  items,
  pathname,
}: {
  title: string;
  density: NavSectionDensity;
  items: NavItem[];
  pathname: string;
}) {
  const rowGapClassName =
    density === "compact"
      ? "gap-[var(--layout-shell-sidebar-row-gap-compact)]"
      : "gap-[var(--layout-shell-sidebar-row-gap-default)]";

  return (
    <div className="flex flex-col gap-[var(--layout-shell-sidebar-section-title-gap)]">
      <p className="text-body-sm-bold px-[var(--layout-shell-sidebar-section-label-padding-inline)] text-text-low">
        {title}
      </p>
      <div className={cn("flex flex-col", rowGapClassName)}>
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
      className="relative flex max-w-[var(--layout-shell-top-control-max-width)] cursor-pointer items-center gap-[var(--layout-shell-top-controls-gap)] rounded-[10px] border border-[rgba(28,28,29,0.08)] bg-white py-2 pr-3 pl-2 shadow-[0px_1px_3px_0px_rgba(0,0,0,0.1)] outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-[rgba(255,255,255,0.9)] focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.14)] motion-reduce:transition-none"
    >
      {orgImageUrl ? (
        <Image src={orgImageUrl} alt={orgName} width={28} height={28} className="rounded-[6px]" />
      ) : (
        <div className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-[rgba(28,28,29,0.08)]">
          <span className="text-[12px] font-[var(--font-weight-semibold)] text-text-low">
            {orgName.charAt(0).toUpperCase()}
          </span>
        </div>
      )}
      <span className="text-body-lg-bold min-w-0 flex-1 truncate text-left text-text-extra-high">
        {orgName}
      </span>
      <svg
        className="h-6 w-6 shrink-0 text-text-extra-low"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M6 9l6 6 6-6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="absolute inset-[-1px] pointer-events-none rounded-[inherit] shadow-[inset_0px_-1px_0px_0px_rgba(0,0,0,0.1)]" />
    </button>
  );
}

interface UserProfileRowProps {
  userName: string;
  userImageUrl?: string;
  onUserClick?: () => void;
}

function UserProfileRow({ userName, userImageUrl, onUserClick }: UserProfileRowProps) {
  const rowClassName =
    "flex h-[var(--layout-shell-nav-row-height)] w-full items-center gap-[var(--layout-shell-nav-row-gap)] rounded-[var(--layout-shell-nav-row-radius)] p-[var(--layout-shell-nav-row-padding)]";

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
      <span className="text-body-lg-bold min-w-0 truncate text-text-medium">
        {userName}
      </span>
    </>
  );

  if (onUserClick) {
    return (
      <button
        type="button"
        onClick={onUserClick}
        className={cn(
          rowClassName,
          "cursor-pointer outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-border-extra-light focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.14)] motion-reduce:transition-none"
        )}
      >
        {content}
      </button>
    );
  }

  return <div className={rowClassName}>{content}</div>;
}

export interface SidebarNavProps {
  orgName: string;
  orgImageUrl?: string;
  userName: string;
  userImageUrl?: string;
  orgSwitcher?: ReactNode;
  userRow?: ReactNode;
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
  orgSwitcher,
  userRow,
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
        "flex w-full max-w-[var(--layout-shell-sidebar-width)] shrink-0 flex-col justify-between bg-[#e9e7de]",
        className
      )}
    >
      {/* Top: org switcher + nav sections */}
      <div className="flex flex-col gap-[var(--layout-shell-sidebar-top-gap)] px-[var(--layout-shell-sidebar-padding-inline)] py-[var(--layout-shell-sidebar-padding-block)]">
        {/* Org switcher row */}
        <div className="flex items-center justify-between gap-[var(--layout-shell-top-controls-gap)]">
          <div className="min-w-0 max-w-[var(--layout-shell-top-control-max-width)] shrink">
            {orgSwitcher ?? (
              <OrgSwitcherPill orgName={orgName} orgImageUrl={orgImageUrl} onClick={onOrgClick} />
            )}
          </div>
          {onCollapse && (
            <button
              type="button"
              aria-label="Close navigation"
              onClick={onCollapse}
              className="inline-flex h-[var(--layout-shell-collapse-button-size)] w-[var(--layout-shell-collapse-button-size)] shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-medium outline-none transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-[rgba(28,28,29,0.08)] focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.14)] motion-reduce:transition-none"
            >
              <PanelLeft {...sidebarIconProps} />
            </button>
          )}
        </div>

        {/* Nav sections */}
        <div className="flex flex-col gap-[var(--layout-shell-sidebar-sections-gap)]">
          {navSections.map((section) => (
            <SidebarGroup
              key={section.title}
              title={section.title}
              density={section.density}
              items={section.items}
              pathname={pathname}
            />
          ))}
        </div>
      </div>

      {/* Bottom: API keys, Docs, Settings, divider, user profile */}
      <div className="flex flex-col">
        <div className="flex flex-col gap-[var(--layout-shell-sidebar-section-title-gap)] px-[var(--layout-shell-sidebar-padding-inline)] py-[var(--layout-shell-sidebar-padding-block)]">
          {bottomNavItems.map((item) => (
            <NavItemLink key={item.label} item={item} pathname={pathname} />
          ))}
          {/* Divider */}
          <div className="h-[1.5px] bg-border-extra-light" />
          {/* User profile row */}
          {userRow ?? (
            <UserProfileRow
              userName={userName}
              userImageUrl={userImageUrl}
              onUserClick={onUserClick}
            />
          )}
        </div>
        {/* Bottom border */}
        <div className="h-px bg-border-light" />
      </div>
    </nav>
  );
}
