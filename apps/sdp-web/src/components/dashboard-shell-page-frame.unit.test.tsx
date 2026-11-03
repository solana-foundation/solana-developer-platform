// @vitest-environment jsdom

import * as clerk from "@clerk/nextjs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectNotFound from "@/app/dashboard/[projectId]/not-found";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import * as quickStart from "@/components/dashboard-quick-start";
import { DashboardShell } from "@/components/dashboard-shell";
import * as languagePicker from "@/components/language-picker";
import * as networkDebugPanel from "@/components/network-debug-panel";
import * as sentryUserContext from "@/components/sentry-user-context";
import * as sidebarUserMenu from "@/components/sidebar-user-menu";
import * as workspaceSwitcher from "@/components/workspace-switcher";
import * as workspace from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { dashboardFlagsAt } from "@/test/release-channel-flags";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

/** A signed-in member of the test's Organization, as Clerk's hook reports one. */
const SIGNED_IN: ReturnType<typeof clerk.useAuth> = {
  isLoaded: true,
  isSignedIn: true,
  userId: "user_page_frame",
  sessionId: "sess_page_frame",
  sessionClaims: {
    __raw: "",
    iss: "https://clerk.page-frame.test",
    sub: "user_page_frame",
    sid: "sess_page_frame",
    nbf: 0,
    exp: 0,
    iat: 0,
  },
  actor: null,
  orgId: "org-page-frame",
  orgRole: "org:admin",
  orgSlug: null,
  has: () => true,
  signOut: async () => undefined,
  getToken: async () => null,
};

// jsdom lays nothing out, so it has no scrollIntoView; the header tabs scroll the active one in.
Element.prototype.scrollIntoView = () => {};

const PROJECT = `/dashboard/${SANDBOX_PROJECT.id}`;
const FLAGS = dashboardFlagsAt("stable");

let container: HTMLDivElement;
let root: Root;

async function renderAt(url: string, children: ReactNode = <div />) {
  setDashboardUrl(url, {});
  await act(async () =>
    root.render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <DashboardShell flags={FLAGS}>{children}</DashboardShell>
      </I18nProvider>
    )
  );
}

function frame(): Element | null {
  return container.querySelector("[data-dashboard-page-frame]");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no matchMedia; the shell closes its phone navigation on a breakpoint change.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.spyOn(clerk, "useAuth").mockReturnValue(SIGNED_IN);
  vi.spyOn(workspace, "useOptionalDashboardWorkspace").mockReturnValue(undefined);
  vi.spyOn(workspace, "useDashboardWorkspace").mockReturnValue({
    initialQuickStartStatus: null,
    dashboardAccess: resolveDashboardAccess("admin"),
    flags: FLAGS,
    dashboardCacheScope: { orgId: "org-page-frame", userId: "user-page-frame" },
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
  });
  // Chrome with its own data reads, none of which the frame depends on.
  vi.spyOn(workspaceSwitcher, "WorkspaceSwitcher").mockReturnValue(<span />);
  vi.spyOn(sidebarUserMenu, "SidebarUserMenu").mockReturnValue(<span />);
  vi.spyOn(quickStart, "DashboardQuickStart").mockReturnValue(<span />);
  vi.spyOn(networkDebugPanel, "NetworkDebugPanel").mockReturnValue(<span />);
  vi.spyOn(sentryUserContext, "SentryUserContext").mockReturnValue(null);
  vi.spyOn(languagePicker, "LanguagePicker").mockReturnValue(<span />);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDashboardNavigation();
});

describe("dashboard shell page frame", () => {
  // A header that changes height between two routes would otherwise move the kept frame.
  it("replaces the header and content frame on a route change", async () => {
    await renderAt(`${PROJECT}/payments`);
    const first = frame();
    expect(first).not.toBeNull();

    await renderAt(`${PROJECT}/payments/transactions`);

    expect(frame()).not.toBeNull();
    expect(frame()).not.toBe(first);
  });

  it("keeps the frame when only the query changes", async () => {
    await renderAt(`${PROJECT}/payments`);
    const first = frame();

    await renderAt(`${PROJECT}/payments?tab=playground`);

    expect(frame()).toBe(first);
  });

  it("holds a wallet's mark place until the wallet sets its own", async () => {
    const wallet = `${PROJECT}/wallets/wal_test_1`;
    await renderAt(wallet);
    const topBar = container.querySelector("[data-dashboard-stacked-topbar]");
    expect(
      topBar?.querySelector("h1")?.previousElementSibling?.querySelector(".animate-pulse")
    ).not.toBeNull();

    await renderAt(
      wallet,
      <DashboardPageTitle title="Treasury" mark={<span data-real-mark="" />} />
    );

    const named = container.querySelector("[data-dashboard-stacked-topbar]");
    expect(named?.querySelector("h1")?.textContent).toBe("Treasury");
    expect(named?.querySelector("[data-real-mark]")).not.toBeNull();
    expect(named?.querySelector(".animate-pulse")).toBeNull();
  });

  it.each([
    // New draft hides its title, since the flow names itself in its step header.
    ["a route that hides its title", `${PROJECT}/issuance/create`],
    ["an address no route matches", `${PROJECT}/no-such-page`],
  ])("shows a missing page's title on %s", async (_label, url) => {
    await renderAt(url, <ProjectNotFound />);

    const titles = [...container.querySelectorAll("h1")];
    expect(titles.map((title) => title.textContent)).toEqual(["Page not found"]);
    expect(titles[0]?.className).not.toContain("sr-only");
  });
});
