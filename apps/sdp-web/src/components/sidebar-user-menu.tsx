"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { cn } from "@sdp/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { ToggleSwitch } from "@sdp/ui/toggle-switch";
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  BugIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  type LucideIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  SunMoonIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { docsHref } from "@/components/dashboard-nav";
import { UserAvatar } from "@/components/user-avatar";
import { useNetworkDebug } from "@/contexts/network-debug-context";
import { THEME_PREFERENCES, type ThemePreference, useTheme } from "@/contexts/theme-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import {
  DASHBOARD_ACCOUNT_HREF,
  DASHBOARD_FEEDBACK_HREF,
} from "@/lib/dashboard-navigation-loading";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { userDisplayName } from "@/lib/user-display-name";

// The sidebar footer: one profile row that carries the signed-in identity and
// opens the account menu — account settings, the colour theme, API docs,
// feedback, the API debug-log switch, and sign out.
const MENU_ITEM_CLASS = "gap-2.5 font-normal";

export function SidebarUserMenu({ collapsed }: { collapsed: boolean }) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  if (!isLoaded) {
    return (
      <div
        role="status"
        aria-label={t("Shared.SharedComponents.loading")}
        aria-busy="true"
        className={cn("flex h-12 items-center", collapsed ? "w-full justify-center" : "gap-3 px-2")}
      >
        <SkeletonBlock className="size-8 shrink-0 rounded-full" />
        {collapsed ? null : (
          <div className="flex flex-1 flex-col gap-1.5">
            <SkeletonBlock className="h-3.5 w-24 rounded" />
            <SkeletonBlock className="h-3 w-32 rounded" />
          </div>
        )}
      </div>
    );
  }
  if (!user) {
    return null;
  }
  const email = user.primaryEmailAddress?.emailAddress;
  const name = userDisplayName(user);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("Shared.dashboardShell.accountMenu")}
          className={cn(
            "flex h-12 items-center rounded-[var(--button-radius-lg)] text-left transition-colors hover:bg-fill focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            collapsed ? "w-full justify-center" : "w-full min-w-0 px-2 gap-3"
          )}
        >
          <UserAvatar name={name} imageUrl={user.imageUrl} />
          {collapsed ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate leading-tight text-primary text-field font-medium">
                  {name}
                </span>
                {email ? (
                  <span className="truncate leading-tight text-meta text-secondary">{email}</span>
                ) : null}
              </span>
              <ChevronsUpDownIcon className="size-4 shrink-0 text-tertiary" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-72 bg-surface-sunken"
      >
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <UserAvatar name={name} imageUrl={user.imageUrl} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-field font-medium text-primary">{name}</span>
            {email ? <span className="truncate text-meta text-secondary">{email}</span> : null}
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className={MENU_ITEM_CLASS}>
          <Link href={projectHref(DASHBOARD_ACCOUNT_HREF)}>
            <UserRoundIcon className="size-4 shrink-0 text-secondary" />
            {t("Shared.dashboardShell.accountSettings")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <ThemeMenuItem />
        <DropdownMenuItem asChild className={MENU_ITEM_CLASS}>
          <Link href={projectHref(DASHBOARD_FEEDBACK_HREF)}>
            <MessageSquareIcon className="size-4 shrink-0 text-secondary" />
            {t("Feedback.label")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className={MENU_ITEM_CLASS}>
          <a href={docsHref} target="_blank" rel="noopener noreferrer">
            <BookOpenIcon className="size-4 shrink-0 text-secondary" />
            <span className="min-w-0 flex-1">{t("Shared.dashboardShell.apiDocs")}</span>
            <ArrowUpRightIcon className="size-4 shrink-0 text-tertiary" />
          </a>
        </DropdownMenuItem>
        <NetworkDebugMenuItem />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className={MENU_ITEM_CLASS}
          onSelect={() => {
            void signOut();
          }}
        >
          <LogOutIcon className="size-4 shrink-0 text-secondary" />
          {t("Shared.dashboardShell.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const THEME_PREFERENCE_PRESENTATIONS = {
  system: { icon: MonitorIcon, labelKey: "DashboardCustody.themeSystem" },
  light: { icon: SunIcon, labelKey: "DashboardCustody.themeLight" },
  dark: { icon: MoonIcon, labelKey: "DashboardCustody.themeDark" },
} as const satisfies Record<ThemePreference, { icon: LucideIcon; labelKey: MessageKey }>;

// The colour theme as one row, like the debug switch beside it: the label on
// the left and a three-icon segmented control on the right. Each segment sets
// its preference directly; selecting the row itself (keyboard) cycles to the
// next one. Neither closes the menu, so the change is visible where it was made.
function ThemeMenuItem() {
  const t = useTranslations();
  const { preference, setPreference } = useTheme();

  return (
    <DropdownMenuItem
      className={MENU_ITEM_CLASS}
      onSelect={(event) => {
        event.preventDefault();
        const next =
          THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(preference) + 1) % THEME_PREFERENCES.length];
        setPreference(next);
      }}
    >
      <SunMoonIcon className="size-4 shrink-0 text-secondary" />
      <span className="min-w-0 flex-1">{t("Shared.dashboardShell.theme")}</span>
      <span className="flex shrink-0 items-center rounded-lg bg-fill-subtle">
        {THEME_PREFERENCES.map((option) => {
          const { icon: Icon, labelKey } = THEME_PREFERENCE_PRESENTATIONS[option];
          const isSelected = preference === option;
          return (
            <button
              key={option}
              type="button"
              tabIndex={-1}
              aria-label={t(labelKey)}
              title={t(labelKey)}
              aria-pressed={isSelected}
              onClick={(event) => {
                // The row's own select would fire too and cycle past the
                // segment the click just chose.
                event.stopPropagation();
                setPreference(option);
              }}
              className={cn(
                "flex h-6 w-9 items-center justify-center rounded-md transition-colors motion-reduce:transition-none",
                isSelected
                  ? "bg-fill text-primary ring-1 ring-border-default"
                  : "text-secondary hover:text-primary"
              )}
            >
              <Icon className="size-4" />
            </button>
          );
        })}
      </span>
    </DropdownMenuItem>
  );
}

// The API debug-log switch. The row is the control — selecting it flips the
// state without closing the menu — and the switch inside it is an inert visual
// so the menu item stays the only interactive element.
function NetworkDebugMenuItem() {
  const t = useTranslations();
  const { available, enabled, setEnabled } = useNetworkDebug();

  if (!available) {
    return null;
  }
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={enabled}
      className={MENU_ITEM_CLASS}
      onSelect={(event) => {
        event.preventDefault();
        setEnabled(!enabled);
      }}
    >
      <BugIcon className="size-4 shrink-0 text-secondary" />
      <span className="min-w-0 flex-1">{t("Shared.SharedComponents.apiDebugLogs")}</span>
      <ToggleSwitch
        checked={enabled}
        onChange={setEnabled}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none h-5 w-9 data-[state=checked]:[&>span]:translate-x-4 [&>span]:size-4"
      />
    </DropdownMenuItem>
  );
}
