// @vitest-environment jsdom

import type { Project } from "@sdp/types";
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
import { DashboardWorkspaceProvider, useDashboardWorkspace } from "./dashboard-workspace-context";

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: true, userId: "user-a", orgId: "org-a" } as {
    isLoaded: boolean;
    userId: string | null;
    orgId: string | null;
  },
  replace: vi.fn(),
  replaceSearchParams: vi.fn(),
  reconcileProjectCookie: vi.fn(),
  selectProject: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/issuance",
  useRouter: () => ({ replace: mocks.replace, refresh: vi.fn() }),
}));
vi.mock("@/lib/dashboard-url-state", () => ({
  readDashboardTabFromUrl: () => null,
  useDashboardUrlState: () => ({
    replaceSearchParams: mocks.replaceSearchParams,
    searchParams: new URLSearchParams(),
  }),
}));
vi.mock("@/lib/project-cookie-action", () => ({
  reconcileProjectCookieAction: mocks.reconcileProjectCookie,
  selectProjectAction: mocks.selectProject,
}));

const projects = [
  {
    id: "project-a",
    organizationId: "org-a",
    name: "Project A",
    slug: "default-sandbox",
    description: null,
    environment: "sandbox",
    settings: null,
    status: "active",
    createdBy: "user-a",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  },
  {
    id: "project-b",
    organizationId: "org-a",
    name: "Project B",
    slug: "project-b",
    description: null,
    environment: "production",
    settings: null,
    status: "active",
    createdBy: "user-a",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  },
] satisfies Project[];

function Probe() {
  const { selectProject } = useDashboardWorkspace();
  return (
    <>
      <button type="button" onClick={() => selectProject("project-a")}>
        Keep project
      </button>
      <button type="button" onClick={() => selectProject("project-b")}>
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
          custody: false,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: true,
          markets: false,
          payments: false,
          policies: false,
          privateChannels: false,
        }}
        serverDashboardCacheScope={{ orgId: "org-a", userId: "user-a" }}
        projects={projects}
        initialSelectedProjectId="project-a"
        shouldRepairInitialProjectCookie={false}
      >
        <Probe />
      </DashboardWorkspaceProvider>
    </>
  );
}

function renderWorkspace() {
  return render(<WorkspaceFixture />);
}

describe("DashboardWorkspaceProvider playground secret boundaries", () => {
  beforeEach(() => {
    cleanup();
    clearStoredApiKeySecrets();
    mocks.auth = { isLoaded: true, userId: "user-a", orgId: "org-a" };
    mocks.replace.mockReset();
    mocks.replaceSearchParams.mockReset();
    mocks.reconcileProjectCookie.mockReset();
    mocks.reconcileProjectCookie.mockResolvedValue(true);
    mocks.selectProject.mockReset();
    mocks.selectProject.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    clearStoredApiKeySecrets();
  });

  it("clears only playground secrets when the project changes", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    storeApiKeySecret({ value: "sk_test_project_a", apiKeyId: "key-a" });
    await user.click(screen.getByRole("button", { name: "Increment unrelated state" }));

    await user.click(screen.getByRole("button", { name: "Switch project" }));

    expect(getStoredApiKeySecret({ apiKeyId: "key-a" })).toBeNull();
    expect(screen.getByLabelText("unrelated state").textContent).toBe("1");
    await waitFor(() => expect(mocks.selectProject).toHaveBeenCalledWith("project-b"));
  });

  it("keeps the secret when the current project is selected again", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    storeApiKeySecret({ value: "sk_test_project_a", apiKeyId: "key-a" });

    await user.click(screen.getByRole("button", { name: "Keep project" }));

    expect(getStoredApiKeySecret({ apiKeyId: "key-a" })).toBe("sk_test_project_a");
  });

  it("clears playground secrets on sign-out without resetting sibling state", async () => {
    const user = userEvent.setup();
    const view = renderWorkspace();
    storeApiKeySecret({ value: "sk_test_user_a", apiKeyId: "key-a" });
    await user.click(screen.getByRole("button", { name: "Increment unrelated state" }));

    mocks.auth = { isLoaded: true, userId: null, orgId: null };
    view.rerender(<WorkspaceFixture />);

    await waitFor(() => expect(getStoredApiKeySecret({ apiKeyId: "key-a" })).toBeNull());
    expect(screen.getByLabelText("unrelated state").textContent).toBe("1");
  });
});
