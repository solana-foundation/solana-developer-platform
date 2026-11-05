// @vitest-environment jsdom

import * as clerkSdk from "@clerk/nextjs";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import useSWR from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearOrganizationSwitch } from "@/contexts/requested-organization-switch";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import type { DashboardCacheScope } from "@/lib/dashboard-cache-scope";
import { clearOrganizationSwitch } from "@/lib/requested-organization-switch";
import {
  dashboardRouter,
  resetDashboardNavigation,
  setDashboardUrl,
} from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { DashboardWorkspaceProvider, useDashboardWorkspace } from "./dashboard-workspace-context";

const clerk = vi.hoisted(() => {
  const auth: {
    isLoaded: boolean;
    sessionId: string;
    userId: string | null;
    orgId: string | null;
  } = {
    isLoaded: true,
    sessionId: "session_test",
    userId: "user_test",
    orgId: "org_test",
  };
  const setActive = vi.fn(async (_params: { organization: string }) => undefined);
  return { auth, setActive };
});

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/dashboard-url-state", () => ({
  readDashboardTabFromUrl: () => null,
  useDashboardUrlState: () => ({
    replaceSearchParams: vi.fn(),
    searchParams: new URLSearchParams(),
  }),
}));

function Probe() {
  const { selectProject, selectedProjectId, sdpEnvironment, switchOrganization } =
    useDashboardWorkspace();
  return (
    <>
      <output aria-label="selected project">{selectedProjectId}</output>
      <output aria-label="environment">{sdpEnvironment}</output>
      <button type="button" onClick={() => selectProject(SANDBOX_PROJECT.id)}>
        Keep project
      </button>
      <button type="button" onClick={() => selectProject(PRODUCTION_PROJECT.id)}>
        Switch project
      </button>
      <button type="button" onClick={() => void switchOrganization("org_test_other")}>
        Switch organization
      </button>
    </>
  );
}

const privatePageQueryKeys = { resource: () => ["session-isolation", "private-resource"] as const };

function PrivatePage({ fetcher }: { fetcher: () => Promise<string> }) {
  const { data } = useSWR(privatePageQueryKeys.resource(), fetcher);
  const [draft, setDraft] = useState("");
  return (
    <>
      <output aria-label="private data">{data}</output>
      <input aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </>
  );
}

function WorkspaceFixture({
  children,
  scope = { orgId: "org_test", userId: "user_test" },
}: {
  children?: ReactNode;
  scope?: DashboardCacheScope;
}) {
  const [unrelatedCount, setUnrelatedCount] = useState(0);
  return (
    <>
      <output aria-label="unrelated state">{unrelatedCount}</output>
      <button type="button" onClick={() => setUnrelatedCount((count) => count + 1)}>
        Increment unrelated state
      </button>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={<div>Refreshing scope</div>}
        dashboardAccess={resolveDashboardAccess("admin")}
        flags={{
          assetProfiles: false,
          compliance: false,
          custody: false,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: true,
          markets: false,
          payments: false,
          privateChannels: false,
          releaseChannel: "experimental",
          ramps: false,
        }}
        serverDashboardCacheScope={scope}
        projects={[SANDBOX_PROJECT, PRODUCTION_PROJECT]}
      >
        {children ?? <Probe />}
      </DashboardWorkspaceProvider>
    </>
  );
}

beforeEach(() => {
  vi.mocked(vi.spyOn(clerkSdk, "useAuth"), { partial: true }).mockImplementation(() => clerk.auth);
  vi.mocked(vi.spyOn(clerkSdk, "useClerk"), { partial: true }).mockImplementation(() => ({
    setActive: clerk.setActive,
  }));
  clerk.setActive.mockReset();
  clerk.setActive.mockResolvedValue(undefined);
  clearOrganizationSwitch();
  cleanup();
  resetDashboardNavigation();
  setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/issuance`, {});
  clerk.auth = {
    isLoaded: true,
    sessionId: "session_test",
    userId: "user_test",
    orgId: "org_test",
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DashboardWorkspaceProvider project selection", () => {
  it("takes the selected project and its environment from the URL", () => {
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/issuance`, {});
    render(<WorkspaceFixture />);

    expect(screen.getByLabelText("selected project").textContent).toBe(PRODUCTION_PROJECT.id);
    expect(screen.getByLabelText("environment").textContent).toBe("production");
  });

  it("is in the sandbox environment on the sandbox project's URL", () => {
    render(<WorkspaceFixture />);

    expect(screen.getByLabelText("selected project").textContent).toBe(SANDBOX_PROJECT.id);
    expect(screen.getByLabelText("environment").textContent).toBe("sandbox");
  });

  it("switches project to the module root under the other project, dropping entity ids", async () => {
    setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/custody/cwlt_test_1`, {
      walletId: "cwlt_test_1",
    });
    const user = userEvent.setup();
    render(<WorkspaceFixture />);

    await user.click(screen.getByRole("button", { name: "Switch project" }));

    await waitFor(() =>
      expect(dashboardRouter.push).toHaveBeenCalledWith(
        `/dashboard/${PRODUCTION_PROJECT.id}/wallets`
      )
    );
  });

  it.each([
    { userId: null, orgId: null },
    { userId: "user_test", orgId: null },
  ])("unmounts private content when the live identity is $userId/$orgId", async (identity) => {
    const view = render(<WorkspaceFixture />);
    clerk.auth = { isLoaded: true, sessionId: "session_test", ...identity };
    view.rerender(<WorkspaceFixture />);

    expect(screen.queryByLabelText("selected project")).toBeNull();
    expect(screen.getByText("Refreshing scope")).toBeTruthy();
    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalledWith("/dashboard"));
  });

  it("isolates late responses and local form state across organization changes", async () => {
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    const fetchFirst = vi.fn(() => first.promise);
    const fetchSecond = vi.fn(() => second.promise);
    const view = render(
      <WorkspaceFixture>
        <PrivatePage fetcher={fetchFirst} />
      </WorkspaceFixture>
    );
    await userEvent.setup().type(screen.getByLabelText("draft"), "old org draft");
    await waitFor(() => expect(fetchFirst).toHaveBeenCalledTimes(1));

    clerk.auth = {
      isLoaded: true,
      sessionId: "session_test",
      userId: "user_test",
      orgId: "org_other",
    };
    view.rerender(
      <WorkspaceFixture scope={{ orgId: "org_other", userId: "user_test" }}>
        <PrivatePage fetcher={fetchSecond} />
      </WorkspaceFixture>
    );
    expect(screen.getByLabelText("draft").getAttribute("value")).toBe("");
    await waitFor(() => expect(fetchSecond).toHaveBeenCalledTimes(1));
    await act(async () => {
      second.resolve("new org data");
    });
    await waitFor(() =>
      expect(screen.getByLabelText("private data").textContent).toBe("new org data")
    );
    await act(async () => {
      first.resolve("old org data");
    });
    expect(screen.getByLabelText("private data").textContent).toBe("new org data");
  });

  it("lands on the bare dashboard after an organization switch this tab asked for", async () => {
    const user = userEvent.setup();
    const view = render(<WorkspaceFixture />);

    await user.click(screen.getByRole("button", { name: "Switch organization" }));
    expect(clerk.setActive.mock.calls).toEqual([[{ organization: "org_test_other" }]]);
    clerk.auth = {
      isLoaded: true,
      sessionId: "session_test",
      userId: "user_test",
      orgId: "org_test_other",
    };
    view.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalledWith("/dashboard"));
    expect(clerk.setActive).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Refreshing scope")).toBeTruthy();
  });

  it("keeps landing on the bare dashboard while the server still renders the previous organization", async () => {
    const user = userEvent.setup();
    const first = render(<WorkspaceFixture />);
    await user.click(screen.getByRole("button", { name: "Switch organization" }));
    clerk.auth = {
      isLoaded: true,
      sessionId: "session_test",
      userId: "user_test",
      orgId: "org_test_other",
    };
    first.rerender(<WorkspaceFixture />);
    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalledTimes(1));

    // The landing rendered org_test again (the cookie had not caught up): a new provider.
    first.unmount();
    render(<WorkspaceFixture />);

    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalledTimes(2));
    expect(clerk.setActive.mock.calls).toEqual([[{ organization: "org_test_other" }]]);
  });

  it("forgets a switch the server never rendered once Clerk agrees with the page again", async () => {
    const user = userEvent.setup();
    const first = render(<WorkspaceFixture />);
    await user.click(screen.getByRole("button", { name: "Switch organization" }));
    clerk.auth = { ...clerk.auth, orgId: "org_test_other" };
    first.rerender(<WorkspaceFixture />);
    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalledTimes(1));

    // The landing rendered org_test, and Clerk went back to it (another tab's switch).
    first.unmount();
    clerk.auth = { ...clerk.auth, orgId: "org_test" };
    const second = render(<WorkspaceFixture />);
    await waitFor(() => expect(screen.getByLabelText("selected project")).toBeTruthy());
    // A later mismatch to the organization once asked for is not this tab's switch.
    clerk.auth = { ...clerk.auth, orgId: "org_test_other" };
    second.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledTimes(2));
    expect(clerk.setActive.mock.calls).toEqual([
      [{ organization: "org_test_other" }],
      [{ organization: "org_test" }],
    ]);
    expect(dashboardRouter.replace).toHaveBeenCalledTimes(1);
  });

  it("makes the page's organization active again when Clerk loads another one, staying on the URL", async () => {
    const view = render(<WorkspaceFixture />);

    // A reload: the server rendered org_test, Clerk's backend still names another.
    clerk.auth = {
      isLoaded: true,
      sessionId: "session_test",
      userId: "user_test",
      orgId: "org_test_other",
    };
    view.rerender(<WorkspaceFixture />);
    view.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalled());
    expect(clerk.setActive.mock.calls).toEqual([[{ organization: "org_test" }]]);
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
    expect(screen.getByText("Refreshing scope")).toBeTruthy();
  });

  it("aligns Clerk again on a later mismatch after one recovered", async () => {
    const view = render(<WorkspaceFixture />);
    clerk.auth = {
      isLoaded: true,
      sessionId: "session_test",
      userId: "user_test",
      orgId: "org_test_other",
    };
    view.rerender(<WorkspaceFixture />);
    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledTimes(1));

    // Clerk made the page's organization active, then reported another one again.
    clerk.auth = {
      isLoaded: true,
      sessionId: "session_test",
      userId: "user_test",
      orgId: "org_test",
    };
    view.rerender(<WorkspaceFixture />);
    await waitFor(() => expect(screen.getByLabelText("selected project")).toBeTruthy());
    clerk.auth = {
      isLoaded: true,
      sessionId: "session_test",
      userId: "user_test",
      orgId: "org_test_other",
    };
    view.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledTimes(2));
    expect(clerk.setActive.mock.calls).toEqual([
      [{ organization: "org_test" }],
      [{ organization: "org_test" }],
    ]);
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it("lands on the bare dashboard when the page's organization cannot be made active", async () => {
    clerk.setActive.mockRejectedValue(new Error("refused"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<WorkspaceFixture />);

    clerk.auth = {
      isLoaded: true,
      sessionId: "session_test",
      userId: "user_test",
      orgId: "org_test_other",
    };
    view.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalledWith("/dashboard"));
    expect(consoleError).toHaveBeenCalled();
  });

  it("lands on the bare dashboard when another person signs in", async () => {
    const view = render(<WorkspaceFixture />);

    clerk.auth = {
      isLoaded: true,
      sessionId: "session_other",
      userId: "user_test_other",
      orgId: "org_test",
    };
    view.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalledWith("/dashboard"));
    expect(clerk.setActive).not.toHaveBeenCalled();
  });
});
