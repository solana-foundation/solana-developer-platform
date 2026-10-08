import type { Project } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextNavigationMock, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { OTHER_ORGANIZATION_PROJECT, PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import {
  resetRequestProject,
  setLastUsedProjectCookie,
  setPageRequest,
} from "@/test/request-project";

const sdpApi = vi.hoisted(() => ({ listSdpProjects: vi.fn<() => Promise<Project[]>>() }));

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/sdp-api", () => ({ listSdpProjects: sdpApi.listSdpProjects }));

import ProjectLayout from "./[projectId]/layout";
import DashboardLandingPage from "./page";

const WORKSPACE_LOADING_REDIRECT = "/workspace-loading?return_to=%2Fdashboard";

async function expectRedirect(render: Promise<unknown>, url: string): Promise<void> {
  await expect(render).rejects.toThrow("NEXT_REDIRECT");
  expect(nextNavigationMock.redirect.mock.calls).toEqual([[url]]);
}

function renderProjectPage(firstSegment: string, pathname: string) {
  setPageRequest(pathname);
  return ProjectLayout({
    children: "project page",
    params: Promise.resolve({ projectId: firstSegment }),
  });
}

beforeEach(() => {
  resetDashboardNavigation();
  resetRequestProject();
  sdpApi.listSdpProjects.mockReset();
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

    await expectRedirect(DashboardLandingPage(), WORKSPACE_LOADING_REDIRECT);
  });
});

describe("project-scoped dashboard layout", () => {
  it("renders a page of a project the user lists", async () => {
    await expect(
      renderProjectPage(PRODUCTION_PROJECT.id, `/dashboard/${PRODUCTION_PROJECT.id}/api-keys`)
    ).resolves.toBe("project page");
    expect(nextNavigationMock.redirect).not.toHaveBeenCalled();
  });

  it("moves a project-less page under the last-used project", async () => {
    setLastUsedProjectCookie(PRODUCTION_PROJECT.id);

    await expectRedirect(
      renderProjectPage("payments", "/dashboard/payments/transfers"),
      `/dashboard/${PRODUCTION_PROJECT.id}/payments/transfers`
    );
  });

  it("moves a project-less page under the sandbox when the last-used project is stale", async () => {
    setLastUsedProjectCookie(OTHER_ORGANIZATION_PROJECT.id);

    await expectRedirect(
      renderProjectPage("payments", "/dashboard/payments/transfers"),
      `/dashboard/${SANDBOX_PROJECT.id}/payments/transfers`
    );
  });

  it("moves a project-less page under the sandbox without a last-used project", async () => {
    await expectRedirect(
      renderProjectPage("custody", "/dashboard/custody/setup"),
      `/dashboard/${SANDBOX_PROJECT.id}/custody/setup`
    );
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

  it("keeps a crafted double-slash path inside the dashboard", async () => {
    await expectRedirect(
      renderProjectPage("evil.com", "/dashboard//evil.com"),
      `/dashboard/${SANDBOX_PROJECT.id}//evil.com`
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
      renderProjectPage("payments", "/dashboard/payments"),
      WORKSPACE_LOADING_REDIRECT
    );
  });
});
