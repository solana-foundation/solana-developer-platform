// @vitest-environment jsdom

import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_MATURITY,
  SDP_RELEASE_CHANNEL_NAMES,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as quickStart from "@/components/dashboard-quick-start";
import { DashboardShell } from "@/components/dashboard-shell";
import * as languagePicker from "@/components/language-picker";
import * as networkDebugPanel from "@/components/network-debug-panel";
import * as sentryUserContext from "@/components/sentry-user-context";
import * as sidebarUserMenu from "@/components/sidebar-user-menu";
import * as workspaceSwitcher from "@/components/workspace-switcher";
import * as workspace from "@/contexts/dashboard-workspace-context";
import type { DashboardFlags } from "@/flags/dashboard";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { dashboardFlagsAt } from "@/test/release-channel-flags";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, orgId: "org-release-channel" }),
  useUser: () => ({ isLoaded: true, isSignedIn: true, user: null }),
  SignInButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const PROJECT = `/dashboard/${SANDBOX_PROJECT.id}`;
const MESSAGES = getMessages("en");

type DashboardWorkspace = ReturnType<typeof workspace.useDashboardWorkspace>;

/** The shell's workspace: an admin on the sandbox Project with the sidebar open. */
function workspaceFor(flags: DashboardFlags): DashboardWorkspace {
  return {
    initialQuickStartStatus: null,
    dashboardAccess: resolveDashboardAccess("admin"),
    flags,
    dashboardCacheScope: { orgId: "org-release-channel", userId: "user-release-channel" },
    projects: [SANDBOX_PROJECT, PRODUCTION_PROJECT],
    sandboxProject: SANDBOX_PROJECT,
    productionProject: PRODUCTION_PROJECT,
    selectedProjectId: SANDBOX_PROJECT.id,
    sdpEnvironment: "sandbox",
    isSidebarOpen: true,
    issuanceTab: "tokens",
    isProjectSwitching: false,
    selectProject: () => undefined,
    setSidebarOpen: () => undefined,
    toggleSidebar: () => undefined,
  };
}

beforeEach(() => {
  vi.spyOn(workspace, "useOptionalDashboardWorkspace").mockReturnValue(undefined);
  // Chrome with its own data reads, none of which lists a module.
  vi.spyOn(workspaceSwitcher, "WorkspaceSwitcher").mockReturnValue(<span />);
  vi.spyOn(sidebarUserMenu, "SidebarUserMenu").mockReturnValue(<span />);
  vi.spyOn(quickStart, "DashboardQuickStart").mockReturnValue(<span />);
  vi.spyOn(networkDebugPanel, "NetworkDebugPanel").mockReturnValue(<span />);
  vi.spyOn(sentryUserContext, "SentryUserContext").mockReturnValue(null);
  vi.spyOn(languagePicker, "LanguagePicker").mockReturnValue(<span />);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function shell(flags: DashboardFlags) {
  vi.spyOn(workspace, "useDashboardWorkspace").mockReturnValue(workspaceFor(flags));
  return (
    <I18nProvider locale="en" messages={MESSAGES}>
      <DashboardShell flags={flags}>
        <div />
      </DashboardShell>
    </I18nProvider>
  );
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`The shell rendered no ${what}`);
  return value;
}

function hrefs(anchors: Iterable<Element>): string[] {
  return [...anchors].map((anchor) => required(anchor.getAttribute("href"), "link href"));
}

function runs(releaseChannel: SdpReleaseChannel, module: SdpModule): boolean {
  return isModuleInReleaseChannel(releaseChannel, module, SDP_RAMP_PROVIDER_MATURITY);
}

/**
 * The navigation links each module owns. A module is listed iff its release channel runs it,
 * checked in both directions so a selector that stopped matching cannot pass as "absent".
 */
const MODULE_LINKS: readonly (readonly [SdpModule, string])[] = [
  ["custody", `${PROJECT}/wallets`],
  ["custody", `${PROJECT}/integrations?tab=custody`],
  ["payments", `${PROJECT}/payments`],
  ["compliance", `${PROJECT}/integrations?tab=compliance`],
  ["ramps", `${PROJECT}/integrations?tab=ramps`],
  ["issuance", `${PROJECT}/issuance`],
  ["markets", `${PROJECT}/markets`],
  ["earn", `${PROJECT}/markets/embedded-yield`],
  ["dvp", `${PROJECT}/markets/dvp`],
  ["private_channels", `${PROJECT}/integrations?tab=privacy`],
  ["helius_rings", `${PROJECT}/helius-rings`],
];

// Each opens its own subnav, so the sidebar lists that section's children.
const PATHS = [`${PROJECT}/integrations`, `${PROJECT}/markets/treasury-solutions`];

function sidebarLinks(flags: DashboardFlags): Set<string> {
  const links = new Set<string>();
  for (const path of PATHS) {
    setDashboardUrl(path, {});
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(shell(flags));
    const sidebar = required(root.querySelector("aside"), "sidebar");
    for (const href of hrefs(sidebar.querySelectorAll("a[href]"))) links.add(href);
  }
  return links;
}

describe("dashboard navigation on each release channel", () => {
  it.each(SDP_RELEASE_CHANNEL_NAMES)("lists only %s's modules", (releaseChannel) => {
    const links = sidebarLinks(dashboardFlagsAt(releaseChannel));

    for (const [module, href] of MODULE_LINKS) {
      expect(links.has(href), `${module} ${href}`).toBe(runs(releaseChannel, module));
    }
  });
});
