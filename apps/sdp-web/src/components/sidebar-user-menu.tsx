"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import * as Sentry from "@sentry/nextjs";
import {
  BugIcon,
  ChevronsUpDownIcon,
  LibraryIcon,
  LogOutIcon,
  type LucideIcon,
  MessageSquarePlusIcon,
  MonitorIcon,
  MoonIcon,
  Settings2Icon,
  SunIcon,
  SunMoonIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { docsHref } from "@/components/dashboard-nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useNetworkDebug } from "@/contexts/network-debug-context";
import { THEME_PREFERENCES, type ThemePreference, useTheme } from "@/contexts/theme-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { cn } from "@/lib/utils";

// The sidebar footer: one profile row that carries the signed-in identity and
// opens the account menu — feedback, API docs, settings, the API debug-log
// switch, the colour theme, and the Clerk account actions the top-bar
// UserButton used to provide. The caller names the side the popover opens on,
// because it knows its own geometry: the desktop sidebar has room to the
// right, while the mobile More sheet spans the viewport and only has room above
// (Radix can only mirror a side, so it cannot recover from "right" on its own).
export function SidebarUserMenu({
  collapsed,
  canManageOrgSettings,
  menuSide,
}: {
  collapsed: boolean;
  canManageOrgSettings: boolean;
  menuSide: "right" | "top";
}) {
  const t = useTranslations();
  const { user } = useUser();
  const { openUserProfile, signOut } = useClerk();
  const { theme } = useTheme();

  useEffect(() => {
    const feedback = Sentry.getFeedback();
    feedback?.setTheme(theme);
  }, [theme]);

  if (!user) {
    return null;
  }
  const email = user.primaryEmailAddress?.emailAddress;
  const fallbackName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const name = user.fullName || fallbackName || user.username || email;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("Shared.dashboardShell.accountMenu")}
          className={cn(
            "flex h-12 items-center rounded-[var(--button-radius-lg)] text-left transition-colors hover:bg-fill-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            collapsed ? "w-full justify-center" : "w-full min-w-0 gap-2.5 px-2"
          )}
        >
          <UserAvatar name={name} imageUrl={user.imageUrl} />
          {collapsed ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold leading-tight text-primary">
                  {name}
                </span>
                {email ? (
                  <span className="truncate text-xs leading-tight text-tertiary">{email}</span>
                ) : null}
              </span>
              <ChevronsUpDownIcon className="size-4 shrink-0 text-tertiary" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={menuSide === "right" ? "end" : "start"}
        side={menuSide}
        sideOffset={6}
        className="w-64"
      >
        <FeedbackMenuItem />
        <DropdownMenuItem asChild className="gap-2.5">
          <a href={docsHref} target="_blank" rel="noopener noreferrer">
            <LibraryIcon className="size-4 shrink-0 text-secondary" />
            {t("Shared.dashboardShell.apiDocs")}
          </a>
        </DropdownMenuItem>
        {canManageOrgSettings ? (
          <DropdownMenuItem asChild className="gap-2.5">
            <Link href={DASHBOARD_SIDE_NAV_HREFS.settings}>
              <Settings2Icon className="size-4 shrink-0 text-secondary" />
              {t("Shared.dashboardShell.settings")}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <NetworkDebugMenuItem />
        <ThemeMenuItem />
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5" onSelect={() => openUserProfile()}>
          <UserRoundIcon className="size-4 shrink-0 text-secondary" />
          {t("Shared.dashboardShell.manageAccount")}
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" onSelect={() => void signOut()}>
          <LogOutIcon className="size-4 shrink-0 text-secondary" />
          {t("Shared.dashboardShell.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserAvatar({ name, imageUrl }: { name: string | undefined; imageUrl: string }) {
  if (imageUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: Clerk provides external URLs not in next/image config.
      <img
        src={imageUrl}
        alt=""
        className="size-7 shrink-0 rounded-full object-cover"
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-on-primary">
      {(name ?? "").trim().slice(0, 2).toUpperCase() || "?"}
    </span>
  );
}

// Sentry's feedback widget wires its dialog to a DOM node, so the item hands it
// its own element. The item mounts with the menu content, which is when the
// attachment needs to exist; letting the menu close on select is fine — the
// dialog Sentry opened outlives the node it was attached to.
function FeedbackMenuItem() {
  const t = useTranslations();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const feedback = Sentry.getFeedback();
    if (!feedback || !ref.current) return;
    return feedback.attachTo(ref.current);
  }, []);

  return (
    <DropdownMenuItem ref={ref} className="gap-2.5">
      <MessageSquarePlusIcon className="size-4 shrink-0 text-secondary" />
      {t("Feedback.label")}
    </DropdownMenuItem>
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
      className="gap-2.5"
      onSelect={(event) => {
        event.preventDefault();
        const next =
          THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(preference) + 1) % THEME_PREFERENCES.length];
        setPreference(next);
      }}
    >
      <SunMoonIcon className="size-4 shrink-0 text-secondary" />
      <span className="min-w-0 flex-1">{t("Shared.dashboardShell.colorTheme")}</span>
      <span className="flex shrink-0 items-center gap-0.5 rounded-lg bg-fill-subtle p-0.5">
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
                "flex size-6 items-center justify-center rounded-md transition-colors motion-reduce:transition-none",
                isSelected
                  ? "bg-surface-raised text-primary shadow-sm ring-1 ring-border-default"
                  : "text-tertiary hover:text-primary"
              )}
            >
              <Icon className="size-3.5" />
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
      className="gap-2.5"
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
