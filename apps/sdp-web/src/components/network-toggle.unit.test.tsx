// @vitest-environment jsdom

import type { Project } from "@sdp/types/projects";
import type { OrganizationRole } from "@sdp/types/roles";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspaceContext from "@/contexts/dashboard-workspace-context";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import {
  dashboardRouter,
  resetDashboardNavigation,
  setDashboardUrl,
} from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { NetworkToggle } from "./network-toggle";

const mocks = vi.hoisted(() => ({
  workspace: {
    sandboxProject: null as Project | null,
    productionProject: null as Project | null,
    sdpEnvironment: "sandbox" as Project["environment"],
    isProjectSwitching: false,
  },
  deployment: { sandboxOnly: false },
  member: { role: "admin" as OrganizationRole },
  selectProject: vi.fn<(projectId: string) => void>(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/deployment-sandbox-only", () => ({
  useDeploymentSandboxOnly: () => mocks.deployment.sandboxOnly,
}));

function show(project: Project) {
  setDashboardUrl(`/dashboard/${project.id}/payments`, {});
  mocks.workspace.sdpEnvironment = project.environment;
}

function renderToggle(disabled = false) {
  render(<NetworkToggle disabled={disabled} />, { wrapper: EnglishI18n });
}

function radio(name: string): HTMLInputElement {
  const element = screen.getByRole("radio", { name });
  if (!(element instanceof HTMLInputElement)) throw new Error(`${name} is not a radio input`);
  return element;
}

function networkGroup(): HTMLFieldSetElement {
  const element = screen.getByRole("group", { name: "Network" });
  if (!(element instanceof HTMLFieldSetElement)) throw new Error("Network is not a fieldset");
  return element;
}

beforeEach(() => {
  resetDashboardNavigation();
  mocks.workspace.sandboxProject = SANDBOX_PROJECT;
  mocks.workspace.productionProject = PRODUCTION_PROJECT;
  mocks.workspace.isProjectSwitching = false;
  mocks.deployment.sandboxOnly = false;
  mocks.member.role = "admin";
  mocks.selectProject.mockReset();
  vi.mocked(vi.spyOn(workspaceContext, "useDashboardWorkspace"), {
    partial: true,
  }).mockImplementation(() => ({
    ...mocks.workspace,
    dashboardAccess: resolveDashboardAccess(mocks.member.role),
    selectProject: mocks.selectProject,
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NetworkToggle", () => {
  it("checks the current network and switches to the other network's project", async () => {
    show(SANDBOX_PROJECT);
    renderToggle();
    const devnet = radio("Devnet");
    const mainnet = radio("Mainnet");
    expect(networkGroup().disabled).toBe(false);
    expect(devnet.checked).toBe(true);
    expect(mainnet.checked).toBe(false);

    await userEvent.setup().click(mainnet);

    expect(mocks.selectProject).toHaveBeenCalledWith(PRODUCTION_PROJECT.id);
  });

  it("switches back to devnet from mainnet", async () => {
    show(PRODUCTION_PROJECT);
    renderToggle();

    await userEvent.setup().click(radio("Devnet"));

    expect(mocks.selectProject).toHaveBeenCalledWith(SANDBOX_PROJECT.id);
  });

  it("opens the mainnet request in Settings for an admin while mainnet is not approved", async () => {
    mocks.workspace.productionProject = null;
    show(SANDBOX_PROJECT);
    renderToggle();

    await userEvent.setup().click(radio("Mainnet"));

    expect(mocks.selectProject).not.toHaveBeenCalled();
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      `/dashboard/${SANDBOX_PROJECT.id}/settings#mainnet-access`
    );
  });

  it("tells a member that an admin requests mainnet, without leaving the page", async () => {
    mocks.workspace.productionProject = null;
    mocks.member.role = "member";
    const info = vi.spyOn(toast, "info");
    show(SANDBOX_PROJECT);
    renderToggle();

    await userEvent.setup().click(radio("Mainnet"));

    expect(dashboardRouter.push).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("Only an admin can request mainnet access.");
  });

  it("holds while a project or organization switch is in flight", () => {
    mocks.workspace.isProjectSwitching = true;
    show(SANDBOX_PROJECT);
    renderToggle();
    expect(networkGroup().disabled).toBe(true);

    cleanup();
    mocks.workspace.isProjectSwitching = false;
    renderToggle(true);
    expect(networkGroup().disabled).toBe(true);
  });

  it("shows nothing on a deployment that serves one network", () => {
    mocks.deployment.sandboxOnly = true;
    show(SANDBOX_PROJECT);
    renderToggle();
    expect(screen.queryByRole("group", { name: "Network" })).toBeNull();

    cleanup();
    mocks.deployment.sandboxOnly = false;
    mocks.workspace.sandboxProject = null;
    show(PRODUCTION_PROJECT);
    renderToggle();
    expect(screen.queryByRole("group", { name: "Network" })).toBeNull();
  });
});
