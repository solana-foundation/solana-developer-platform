// @vitest-environment jsdom

import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_MATURITY,
  SDP_RELEASE_CHANNEL_NAMES,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types/unified-transactions";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enabledTransactionModules } from "@/app/dashboard/[projectId]/payments/transactions/transaction-modules";
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
import { DASHBOARD_DESIGNS, dashboardFlagsAt } from "@/test/release-channel-flags";

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
    initialQuickStartStep: null,
    dashboardAccess: resolveDashboardAccess("org:admin"),
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
  vi.unstubAllGlobals();
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

const CASES = SDP_RELEASE_CHANNEL_NAMES.flatMap((releaseChannel) =>
  DASHBOARD_DESIGNS.map((design) => ({ releaseChannel, design }))
);

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
  it.each(CASES)(
    "lists only $releaseChannel's modules on $design",
    ({ releaseChannel, design }) => {
      const links = sidebarLinks(dashboardFlagsAt(releaseChannel, design));

      for (const [module, href] of MODULE_LINKS) {
        expect(links.has(href), `${module} ${href}`).toBe(runs(releaseChannel, module));
      }
    }
  );

  // The previous design's phone swaps the sidebar for a bottom bar and a More sheet, each
  // wired to the flags by hand.
  const PHONE_LINKS: readonly (readonly [SdpModule, string])[] = [
    ["custody", `${PROJECT}/wallets`],
    ["payments", `${PROJECT}/payments`],
    ["issuance", `${PROJECT}/issuance`],
    ["markets", `${PROJECT}/markets`],
    ["helius_rings", `${PROJECT}/helius-rings`],
  ];

  it.each(SDP_RELEASE_CHANNEL_NAMES)(
    "lists only %s's modules on the previous design's phone",
    async (releaseChannel) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
      // jsdom has no layout, so no `scrollIntoView`; the header's tab strip calls it.
      Element.prototype.scrollIntoView = () => undefined;
      setDashboardUrl(`${PROJECT}/payments`, {});
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(shell(dashboardFlagsAt(releaseChannel, "legacy"))));
        const bottomNav = required(
          container.querySelector("[data-dashboard-bottom-nav]"),
          "bottom bar"
        );
        const links = new Set(hrefs(bottomNav.querySelectorAll("a[href]")));
        const more = required(bottomNav.querySelector<HTMLButtonElement>("button"), "More button");
        await act(async () => more.click());
        const sheet = required(
          container.querySelector("[data-dashboard-more-sheet]"),
          "More sheet"
        );
        for (const href of hrefs(sheet.querySelectorAll("a[href]"))) links.add(href);

        for (const [module, href] of PHONE_LINKS) {
          expect(links.has(href), module).toBe(runs(releaseChannel, module));
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  );

  it.each(SDP_RELEASE_CHANNEL_NAMES)(
    "tabs the previous design's Transactions by %s's modules only",
    (releaseChannel) => {
      // The redesign has no module tabs; its Type filter is covered beside the page.
      const flags = dashboardFlagsAt(releaseChannel, "legacy");
      setDashboardUrl(`${PROJECT}/payments/transactions`, {});
      const root = document.createElement("div");
      root.innerHTML = renderToStaticMarkup(shell(flags));
      const tabs = [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
      const shown = enabledTransactionModules(flags);
      expect(tabs.length).toBeGreaterThan(shown.length);
      for (const module of UNIFIED_TRANSACTION_MODULES) {
        const label = MESSAGES.DashboardPayments.transactions.modules[module];
        expect(tabs.includes(label), module).toBe(shown.includes(module));
      }
    }
  );
});
