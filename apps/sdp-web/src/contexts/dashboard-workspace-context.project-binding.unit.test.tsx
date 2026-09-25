// @vitest-environment jsdom

/**
 * Regression coverage for APE-880 (SOLA9-598): the mounted dashboard workspace
 * provider must never keep a project ID that the authoritative project list no
 * longer contains. When the server resolves a repaired selection (stale cookie
 * after an entitlement change), the provider has to adopt it before rendering
 * mutation-capable children, so client state, cache keys and the BFF's
 * request-scoped `x-project-id` stay on the same project.
 */

import type { Project } from "@sdp/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { DashboardWorkspaceProvider, useDashboardWorkspace } from "./dashboard-workspace-context";

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: true, userId: "user-a", orgId: "org-a" },
  replace: vi.fn(),
  selectProjectAction: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/payments",
  useRouter: () => ({ replace: mocks.replace, refresh: vi.fn() }),
}));
vi.mock("@/lib/dashboard-url-state", () => ({
  readDashboardTabFromUrl: () => null,
  useDashboardUrlState: () => ({
    replaceSearchParams: vi.fn(),
    searchParams: new URLSearchParams(),
  }),
}));
vi.mock("@/lib/project-cookie-action", () => ({
  reconcileProjectCookieAction: vi.fn().mockResolvedValue(true),
  selectProjectAction: mocks.selectProjectAction,
}));

const sandbox = {
  id: "project-sandbox",
  organizationId: "org-a",
  name: "Sandbox",
  slug: "default-sandbox",
  description: null,
  environment: "sandbox",
  settings: null,
  status: "active",
  createdBy: "user-a",
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
} satisfies Project;

const production = {
  ...sandbox,
  id: "project-production",
  name: "Production",
  slug: "default-production",
  environment: "production",
} satisfies Project;

const flags = {
  assetProfiles: false,
  custody: true,
  dvp: false,
  earn: false,
  heliusRings: false,
  issuance: false,
  markets: false,
  payments: true,
  policies: true,
  privateChannels: false,
};

const observedRenders: { listed: string[]; selected: string | null }[] = [];

function Probe() {
  const { projects, selectedProjectId, sdpEnvironment } = useDashboardWorkspace();
  observedRenders.push({
    listed: projects.map((project) => project.id),
    selected: selectedProjectId,
  });
  return (
    <output aria-label="workspace-binding">
      {JSON.stringify({
        listedProjectIds: projects.map((project) => project.id),
        selectedProjectId,
        sdpEnvironment,
      })}
    </output>
  );
}

function workspaceProps(
  overrides: Partial<React.ComponentProps<typeof DashboardWorkspaceProvider>> = {}
) {
  return {
    scopeRefreshFallback: <div>Refreshing scope</div>,
    dashboardAccess: resolveDashboardAccess("org:admin"),
    flags,
    serverDashboardCacheScope: { orgId: "org-a", userId: "user-a" },
    projects: [sandbox, production],
    initialSelectedProjectId: production.id,
    shouldRepairInitialProjectCookie: false,
    children: <Probe />,
    ...overrides,
  };
}

describe("DashboardWorkspaceProvider project binding", () => {
  beforeEach(() => {
    cleanup();
    observedRenders.length = 0;
    mocks.replace.mockReset();
    mocks.selectProjectAction.mockReset();
    mocks.selectProjectAction.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it("reconciles the mounted selection when the authoritative list removes the selected project", async () => {
    const view = render(<DashboardWorkspaceProvider {...workspaceProps()} />);

    expect(JSON.parse(screen.getByLabelText("workspace-binding").textContent ?? "{}")).toEqual({
      listedProjectIds: [sandbox.id, production.id],
      selectedProjectId: production.id,
      sdpEnvironment: "production",
    });

    // A refreshed authoritative project list drops the production project
    // (archived project / revoked entitlement) and the server flags the stale
    // cookie for repair, resolving the selection to sandbox.
    view.rerender(
      <DashboardWorkspaceProvider
        {...workspaceProps({
          projects: [sandbox],
          initialSelectedProjectId: sandbox.id,
          shouldRepairInitialProjectCookie: true,
        })}
      />
    );

    // The cookie repair still happens…
    await waitFor(() => expect(mocks.selectProjectAction).toHaveBeenCalledWith(sandbox.id));

    // …and the mounted provider must adopt the repaired selection instead of
    // keeping the removed production project.
    expect(JSON.parse(screen.getByLabelText("workspace-binding").textContent ?? "{}")).toEqual({
      listedProjectIds: [sandbox.id],
      selectedProjectId: sandbox.id,
      sdpEnvironment: "sandbox",
    });
  });

  it("never exposes the removed project after the authoritative refresh", async () => {
    const view = render(<DashboardWorkspaceProvider {...workspaceProps()} />);
    const renderCountBeforeRefresh = observedRenders.length;

    view.rerender(
      <DashboardWorkspaceProvider
        {...workspaceProps({
          projects: [sandbox],
          initialSelectedProjectId: sandbox.id,
          shouldRepairInitialProjectCookie: true,
        })}
      />
    );

    await waitFor(() => expect(mocks.selectProjectAction).toHaveBeenCalledWith(sandbox.id));

    // Every render after the refresh observed a listed project only: the
    // removed production ID must not leak into mutation-capable children.
    const observedAfterRefresh = observedRenders.slice(renderCountBeforeRefresh);
    expect(observedAfterRefresh.length).toBeGreaterThan(0);
    for (const observed of observedAfterRefresh) {
      expect(observed.listed).not.toContain(production.id);
      expect(observed.selected).not.toBe(production.id);
    }
  });

  it("keeps the mounted selection when a project-list refresh is non-authoritative", async () => {
    const view = render(<DashboardWorkspaceProvider {...workspaceProps()} />);

    // A failed list load renders an empty, non-authoritative list with no
    // repair flag: the mounted selection must survive it, and no cookie write
    // may be triggered.
    view.rerender(
      <DashboardWorkspaceProvider
        {...workspaceProps({
          projects: [],
          initialSelectedProjectId: null,
          shouldRepairInitialProjectCookie: false,
        })}
      />
    );

    expect(JSON.parse(screen.getByLabelText("workspace-binding").textContent ?? "{}")).toEqual({
      listedProjectIds: [],
      selectedProjectId: production.id,
      sdpEnvironment: "sandbox",
    });
    expect(mocks.selectProjectAction).not.toHaveBeenCalled();
  });
});
