import type { Project } from "@sdp/types/projects";
import type { OrganizationRole } from "@sdp/types/roles";
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
  requestMemberRole: vi.fn(async (): Promise<OrganizationRole> => "admin"),
}));

const sdpAuth = vi.hoisted(() => ({
  getSdpAuth: vi.fn(async () => ({ orgId: "org_test", userId: "user_test" })),
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
      privateChannels: false,
      releaseChannel: "experimental",
      ramps: false,
    }) as const satisfies DashboardFlags
);

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/sdp-api", () => sdpApi);
vi.mock("@/lib/sdp-auth", () => sdpAuth);
vi.mock("@/flags/dashboard", () => ({ getDashboardFlags: async () => DASHBOARD_FLAGS }));
vi.mock("@/lib/quick-start-server", () => ({ loadQuickStartStatus: async () => null }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  DashboardWorkspaceProvider: dashboardShell.DashboardWorkspaceProvider,
}));
vi.mock("@/contexts/network-debug-context", () => ({
  NetworkDebugProvider: dashboardShell.passThrough,
}));
vi.mock("@/components/dashboard-shell", () => ({ DashboardShell: dashboardShell.passThrough }));

import ProjectLayout from "./[projectId]/layout";
import { ProjectOrganizationSwitch } from "./[projectId]/project-organization-switch";
import DashboardLandingPage from "./page";

const WORKSPACE_LOADING_REDIRECT = "/workspace-loading?return_to=%2Fdashboard";

async function expectRedirect(render: Promise<unknown>, url: string): Promise<void> {
  await expect(render).rejects.toThrow("NEXT_REDIRECT");
  expect(nextNavigationMock.redirect.mock.calls).toEqual([[url]]);
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

    await expectRedirect(DashboardLandingPage(), `/dashboard/${PRODUCTION_PROJECT.id}`);
  });

  it("lands on the sandbox when the last-used project is no longer listed", async () => {
    setLastUsedProjectCookie(OTHER_ORGANIZATION_PROJECT.id);

    await expectRedirect(DashboardLandingPage(), `/dashboard/${SANDBOX_PROJECT.id}`);
  });

  it("lands on the sandbox without a last-used project", async () => {
    await expectRedirect(DashboardLandingPage(), `/dashboard/${SANDBOX_PROJECT.id}`);
  });

  it("waits on the workspace loading page while no project is provisioned", async () => {
    sdpApi.listSdpProjects.mockResolvedValue([]);

    await expectRedirect(DashboardLandingPage(), "/workspace-loading");
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

  it("hands a page of an unlisted project to the organization switch, falling back to the sandbox whatever was last used", async () => {
    setLastUsedProjectCookie(PRODUCTION_PROJECT.id);

    const layout = await renderProjectPage(
      OTHER_ORGANIZATION_PROJECT.id,
      `/dashboard/${OTHER_ORGANIZATION_PROJECT.id}/api-keys`
    );

    expect(layout).toMatchObject({
      type: ProjectOrganizationSwitch,
      props: {
        projectId: OTHER_ORGANIZATION_PROJECT.id,
        sessionOrganizationId: "org_test",
        fallbackHref: `/dashboard/${SANDBOX_PROJECT.id}/api-keys`,
      },
    });
    expect(dashboardShell.DashboardWorkspaceProvider).not.toHaveBeenCalled();
    expect(nextNavigationMock.redirect).not.toHaveBeenCalled();
  });

  it("keeps a crafted double-slash path under an unlisted project inside the dashboard", async () => {
    const layout = await renderProjectPage(
      OTHER_ORGANIZATION_PROJECT.id,
      `/dashboard/${OTHER_ORGANIZATION_PROJECT.id}//evil.com`
    );

    expect(layout).toMatchObject({
      props: { fallbackHref: `/dashboard/${SANDBOX_PROJECT.id}//evil.com` },
    });
  });

  it("falls back to the workspace loading page while no project is provisioned", async () => {
    sdpApi.listSdpProjects.mockResolvedValue([]);

    const layout = await renderProjectPage(
      OTHER_ORGANIZATION_PROJECT.id,
      `/dashboard/${OTHER_ORGANIZATION_PROJECT.id}/payments`
    );

    expect(layout).toMatchObject({ props: { fallbackHref: WORKSPACE_LOADING_REDIRECT } });
  });
});
