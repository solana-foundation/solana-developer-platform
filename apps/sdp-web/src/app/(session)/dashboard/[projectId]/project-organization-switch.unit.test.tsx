// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardRouter,
  resetDashboardNavigation,
  setDashboardUrl,
} from "@/test/dashboard-navigation";
import { OTHER_ORGANIZATION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { dashboardFlagsAt } from "@/test/release-channel-flags";

const clerk = vi.hoisted(() => ({
  setActive: vi.fn(async (_params: { organization: string }) => undefined),
  getToken: vi.fn(
    async ({ organizationId }: { organizationId: string }) => `token_${organizationId}`
  ),
  memberships: [] as string[],
}));

const actions = vi.hoisted(() => ({
  findProjectOrganization: vi.fn(
    async (_projectId: string, _tokens: readonly string[]): Promise<number | null> => null
  ),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ setActive: clerk.setActive }),
  useSession: () => ({ isLoaded: true, session: { getToken: clerk.getToken } }),
  useUser: () => ({
    isLoaded: true,
    user: {
      organizationMemberships: clerk.memberships.map((id) => ({ organization: { id } })),
    },
  }),
}));
vi.mock("./project-organization-actions", () => actions);
vi.mock("@/components/dashboard-loading-screen", () => ({
  DashboardLoadingScreen: ({ pathname }: { pathname: string }) => <p>{`Loading ${pathname}`}</p>,
}));

import { ProjectOrganizationSwitch } from "./project-organization-switch";

const FALLBACK_HREF = `/dashboard/${SANDBOX_PROJECT.id}/api-keys`;

function renderSwitch() {
  return render(
    <ProjectOrganizationSwitch
      projectId={OTHER_ORGANIZATION_PROJECT.id}
      sessionOrganizationId="org_test"
      fallbackHref={FALLBACK_HREF}
      flags={dashboardFlagsAt("stable")}
    />
  );
}

beforeEach(() => {
  resetDashboardNavigation();
  setDashboardUrl(`/dashboard/${OTHER_ORGANIZATION_PROJECT.id}/api-keys`, {});
  clerk.setActive.mockClear();
  clerk.getToken.mockClear();
  actions.findProjectOrganization.mockReset();
  actions.findProjectOrganization.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

describe("ProjectOrganizationSwitch", () => {
  it("makes active the other organization that lists the project, rendering nothing of it meanwhile", async () => {
    clerk.memberships = ["org_test", "org_first", "org_second"];
    actions.findProjectOrganization.mockResolvedValue(1);

    const view = renderSwitch();

    expect(view.container.textContent).toBe("Loading /dashboard/api-keys");
    await waitFor(() => expect(clerk.setActive).toHaveBeenCalled());
    expect(clerk.setActive.mock.calls).toEqual([[{ organization: "org_second" }]]);
    expect(clerk.getToken.mock.calls).toEqual([
      [{ organizationId: "org_first" }],
      [{ organizationId: "org_second" }],
    ]);
    expect(actions.findProjectOrganization.mock.calls).toEqual([
      [OTHER_ORGANIZATION_PROJECT.id, ["token_org_first", "token_org_second"]],
    ]);
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it("switches once, though switching hands Clerk's session and user new identities", async () => {
    clerk.memberships = ["org_test", "org_first"];
    actions.findProjectOrganization.mockResolvedValue(0);

    const view = renderSwitch();
    await waitFor(() => expect(clerk.setActive).toHaveBeenCalled());
    view.rerender(
      <ProjectOrganizationSwitch
        projectId={OTHER_ORGANIZATION_PROJECT.id}
        sessionOrganizationId="org_test"
        fallbackHref={FALLBACK_HREF}
        flags={dashboardFlagsAt("stable")}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actions.findProjectOrganization).toHaveBeenCalledTimes(1);
    expect(clerk.setActive).toHaveBeenCalledTimes(1);
  });

  it("looks again once the server renders for another organization", async () => {
    clerk.memberships = ["org_test", "org_first", "org_second"];
    actions.findProjectOrganization.mockResolvedValue(null);

    const view = renderSwitch();
    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalled());
    view.rerender(
      <ProjectOrganizationSwitch
        projectId={OTHER_ORGANIZATION_PROJECT.id}
        sessionOrganizationId="org_first"
        fallbackHref={FALLBACK_HREF}
        flags={dashboardFlagsAt("stable")}
      />
    );

    await waitFor(() => expect(actions.findProjectOrganization).toHaveBeenCalledTimes(2));
    expect(actions.findProjectOrganization.mock.calls[1]).toEqual([
      OTHER_ORGANIZATION_PROJECT.id,
      ["token_org_test", "token_org_second"],
    ]);
  });

  it("goes to the fallback when no other organization lists the project", async () => {
    clerk.memberships = ["org_test", "org_first"];

    renderSwitch();

    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalled());
    expect(dashboardRouter.replace.mock.calls).toEqual([[FALLBACK_HREF]]);
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it("goes to the fallback without asking when the user has no other organization", async () => {
    clerk.memberships = ["org_test"];

    renderSwitch();

    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalled());
    expect(dashboardRouter.replace.mock.calls).toEqual([[FALLBACK_HREF]]);
    expect(actions.findProjectOrganization).not.toHaveBeenCalled();
  });

  it("goes to the fallback when the lookup fails", async () => {
    clerk.memberships = ["org_test", "org_first"];
    actions.findProjectOrganization.mockRejectedValue(new Error("unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderSwitch();

    await waitFor(() => expect(dashboardRouter.replace).toHaveBeenCalled());
    expect(dashboardRouter.replace.mock.calls).toEqual([[FALLBACK_HREF]]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
