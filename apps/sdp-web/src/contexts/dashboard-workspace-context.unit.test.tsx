// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import {
  clearStoredApiKeySecrets,
  getStoredApiKeySecret,
  storeApiKeySecret,
} from "@/lib/playground-api-keys";
import {
  dashboardRouter,
  resetDashboardNavigation,
  setDashboardUrl,
} from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { DashboardWorkspaceProvider, useDashboardWorkspace } from "./dashboard-workspace-context";

const clerk = vi.hoisted(() => {
  const auth: { isLoaded: boolean; userId: string | null; orgId: string | null } = {
    isLoaded: true,
    userId: "user_test",
    orgId: "org_test",
  };
  return { auth };
});

vi.mock("@clerk/nextjs", () => ({ useAuth: () => clerk.auth }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/dashboard-url-state", () => ({
  readDashboardTabFromUrl: () => null,
  useDashboardUrlState: () => ({
    replaceSearchParams: vi.fn(),
    searchParams: new URLSearchParams(),
  }),
}));

function Probe() {
  const { selectProject, selectedProjectId, sdpEnvironment } = useDashboardWorkspace();
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
    </>
  );
}

function WorkspaceFixture() {
  const [unrelatedCount, setUnrelatedCount] = useState(0);
  return (
    <>
      <output aria-label="unrelated state">{unrelatedCount}</output>
      <button type="button" onClick={() => setUnrelatedCount((count) => count + 1)}>
        Increment unrelated state
      </button>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={<div>Refreshing scope</div>}
        dashboardAccess={resolveDashboardAccess("org:admin")}
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
          policies: false,
          privateChannels: false,
          newDesign: true,
          ramps: false,
        }}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[SANDBOX_PROJECT, PRODUCTION_PROJECT]}
      >
        <Probe />
      </DashboardWorkspaceProvider>
    </>
  );
}

beforeEach(() => {
  cleanup();
  clearStoredApiKeySecrets();
  resetDashboardNavigation();
  setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/issuance`, {});
  clerk.auth = { isLoaded: true, userId: "user_test", orgId: "org_test" };
});

afterEach(() => {
  cleanup();
  clearStoredApiKeySecrets();
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

  it("switches project by navigating to the same page under the other project", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFixture />);

    await user.click(screen.getByRole("button", { name: "Switch project" }));

    await waitFor(() =>
      expect(dashboardRouter.push).toHaveBeenCalledWith(
        `/dashboard/${PRODUCTION_PROJECT.id}/issuance`
      )
    );
  });

  it("lands on the bare dashboard when Clerk switches organization under the page", async () => {
    const view = render(<WorkspaceFixture />);

    clerk.auth = { isLoaded: true, userId: "user_test", orgId: "org_test_other" };
    view.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.getByText("Refreshing scope")).toBeTruthy();
  });
});

describe("DashboardWorkspaceProvider playground secret boundaries", () => {
  it("clears only playground secrets when the project changes", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFixture />);
    storeApiKeySecret({ value: "sk_test_project_sandbox", apiKeyId: "key_test_sandbox" });
    await user.click(screen.getByRole("button", { name: "Increment unrelated state" }));

    await user.click(screen.getByRole("button", { name: "Switch project" }));

    expect(getStoredApiKeySecret({ apiKeyId: "key_test_sandbox" })).toBeNull();
    expect(screen.getByLabelText("unrelated state").textContent).toBe("1");
  });

  it("keeps the secret when the current project is selected again", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFixture />);
    storeApiKeySecret({ value: "sk_test_project_sandbox", apiKeyId: "key_test_sandbox" });

    await user.click(screen.getByRole("button", { name: "Keep project" }));

    expect(getStoredApiKeySecret({ apiKeyId: "key_test_sandbox" })).toBe("sk_test_project_sandbox");
  });

  it("clears playground secrets on sign-out without resetting sibling state", async () => {
    const user = userEvent.setup();
    const view = render(<WorkspaceFixture />);
    storeApiKeySecret({ value: "sk_test_user", apiKeyId: "key_test_sandbox" });
    await user.click(screen.getByRole("button", { name: "Increment unrelated state" }));

    clerk.auth = { isLoaded: true, userId: null, orgId: null };
    view.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(getStoredApiKeySecret({ apiKeyId: "key_test_sandbox" })).toBeNull());
    expect(screen.getByLabelText("unrelated state").textContent).toBe("1");
  });
});
