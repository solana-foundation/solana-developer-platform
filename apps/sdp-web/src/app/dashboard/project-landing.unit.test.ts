import type { Project } from "@sdp/types";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardFlags } from "@/flags/dashboard";
import { nextNavigationMock, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { OTHER_ORGANIZATION_PROJECT, PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import {
  resetRequestProject,
  setLastUsedProjectCookie,
  setPageRequest,
} from "@/test/request-project";

const sdpApi = vi.hoisted(() => ({
  listSdpProjects: vi.fn<() => Promise<Project[]>>(),
  getSdpAuth: vi.fn(async () => ({ orgRole: "org:admin", orgId: "org_test", userId: "user_test" })),
}));

const dashboardShell = vi.hoisted(() => ({
  DashboardWorkspaceProvider: vi.fn(
    ({ children }: { children: ReactNode; projects: Project[] }) => children
  ),
  passThrough: ({ children }: { children: ReactNode }) => children,
}));

const DASHBOARD_FLAGS = vi.hoisted(
  () =>
    ({
      assetProfiles: false,
      compliance: false,
      custody: false,
      dvp: false,
      earn: false,
      heliusRings: false,
      issuance: false,
      markets: false,
      payments: false,
      policies: false,
      privateChannels: false,
      ramps: false,
    }) as const satisfies DashboardFlags
);

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/sdp-api", () => sdpApi);
vi.mock("@/flags/dashboard", () => ({ getDashboardFlags: async () => DASHBOARD_FLAGS }));
vi.mock("@/lib/quick-start-server", () => ({ loadQuickStartStep: async () => null }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  DashboardWorkspaceProvider: dashboardShell.DashboardWorkspaceProvider,
}));
vi.mock("@/contexts/network-debug-context", () => ({
  NetworkDebugProvider: dashboardShell.passThrough,
}));
vi.mock("@/components/dashboard-shell", () => ({ DashboardShell: dashboardShell.passThrough }));

import ProjectLayout from "./[projectId]/layout";
import DashboardLandingPage from "./page";

const WORKSPACE_LOADING_REDIRECT = "/workspace-loading?return_to=%2Fdashboard";

async function expectRedirect(render: Promise<unknown>, url: string): Promise<void> {
  await expect(render).rejects.toThrow("NEXT_REDIRECT");
  expect(nextNavigationMock.redirect.mock.calls).toEqual([[url]]);
}

function renderLanding(searchParams: { return_to?: string }) {
  return DashboardLandingPage({ searchParams: Promise.resolve(searchParams) });
}

function renderProjectPage(projectId: string, pathname: string) {
  setPageRequest(pathname);
  return ProjectLayout({
    children: "project page",
    params: Promise.resolve({ projectId }),
  });
}

beforeEach(() => {
  resetDashboardNavigation();
  resetRequestProject();
  sdpApi.listSdpProjects.mockReset();
  dashboardShell.DashboardWorkspaceProvider.mockClear();
  sdpApi.listSdpProjects.mockResolvedValue([SANDBOX_PROJECT, PRODUCTION_PROJECT]);
});

describe("bare dashboard landing", () => {
  it("lands on the last-used project while the organization lists it", async () => {
    setLastUsedProjectCookie(PRODUCTION_PROJECT.id);

    await expectRedirect(renderLanding({}), `/dashboard/${PRODUCTION_PROJECT.id}`);
  });

  it("lands on the sandbox when the last-used project is no longer listed", async () => {
    setLastUsedProjectCookie(OTHER_ORGANIZATION_PROJECT.id);

    await expectRedirect(renderLanding({}), `/dashboard/${SANDBOX_PROJECT.id}`);
  });

  it("lands on the sandbox without a last-used project", async () => {
    await expectRedirect(renderLanding({}), `/dashboard/${SANDBOX_PROJECT.id}`);
  });

  it("returns to the requested page and query inside the last-used project", async () => {
    setLastUsedProjectCookie(PRODUCTION_PROJECT.id);

    await expectRedirect(
      renderLanding({ return_to: "/dashboard/payments/transactions?tab=x" }),
      `/dashboard/${PRODUCTION_PROJECT.id}/payments/transactions?tab=x`
    );
  });

  it("replaces a project named in the requested page with the landing project", async () => {
    setLastUsedProjectCookie(PRODUCTION_PROJECT.id);

    await expectRedirect(
      renderLanding({ return_to: `/dashboard/${OTHER_ORGANIZATION_PROJECT.id}/api-keys?tab=x` }),
      `/dashboard/${PRODUCTION_PROJECT.id}/api-keys?tab=x`
    );
  });

  it.each([
    ["//evil.com", `/dashboard/${SANDBOX_PROJECT.id}`],
    ["https://evil.com/dashboard", `/dashboard/${SANDBOX_PROJECT.id}`],
    ["/dashboard//evil.com", `/dashboard/${SANDBOX_PROJECT.id}//evil.com`],
  ])("keeps a crafted return_to %s inside the dashboard", async (returnTo, url) => {
    await expectRedirect(renderLanding({ return_to: returnTo }), url);
  });

  it("waits on the workspace loading page with the requested page while no project is provisioned", async () => {
    sdpApi.listSdpProjects.mockResolvedValue([]);

    await expectRedirect(
      renderLanding({ return_to: "/dashboard/payments?tab=x" }),
      `/workspace-loading?return_to=${encodeURIComponent("/dashboard/payments?tab=x")}`
    );
  });
});

describe("project-scoped dashboard layout", () => {
  it("renders a page of a project the user lists inside the workspace of the listed projects", async () => {
    const layout = await renderProjectPage(
      PRODUCTION_PROJECT.id,
      `/dashboard/${PRODUCTION_PROJECT.id}/api-keys`
    );

    expect(renderToStaticMarkup(layout)).toBe("project page");
    expect(
      dashboardShell.DashboardWorkspaceProvider.mock.calls.map(([props]) => props.projects)
    ).toEqual([[SANDBOX_PROJECT, PRODUCTION_PROJECT]]);
    expect(nextNavigationMock.redirect).not.toHaveBeenCalled();
  });

  it("moves a page of an unlisted project under the sandbox, whatever was last used", async () => {
    setLastUsedProjectCookie(PRODUCTION_PROJECT.id);

    await expectRedirect(
      renderProjectPage(
        OTHER_ORGANIZATION_PROJECT.id,
        `/dashboard/${OTHER_ORGANIZATION_PROJECT.id}/api-keys`
      ),
      `/dashboard/${SANDBOX_PROJECT.id}/api-keys`
    );
  });

  it("keeps a crafted double-slash path under an unlisted project inside the dashboard", async () => {
    await expectRedirect(
      renderProjectPage(
        OTHER_ORGANIZATION_PROJECT.id,
        `/dashboard/${OTHER_ORGANIZATION_PROJECT.id}//evil.com`
      ),
      `/dashboard/${SANDBOX_PROJECT.id}//evil.com`
    );
  });

  it("waits on the workspace loading page while no project is provisioned", async () => {
    sdpApi.listSdpProjects.mockResolvedValue([]);

    await expectRedirect(
      renderProjectPage(
        OTHER_ORGANIZATION_PROJECT.id,
        `/dashboard/${OTHER_ORGANIZATION_PROJECT.id}/payments`
      ),
      WORKSPACE_LOADING_REDIRECT
    );
  });
});
