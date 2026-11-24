// @vitest-environment jsdom

import type { Project } from "@sdp/types/projects";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspaceContext from "@/contexts/dashboard-workspace-context";
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

function renderToggle() {
  render(<NetworkToggle />, { wrapper: EnglishI18n });
}

beforeEach(() => {
  resetDashboardNavigation();
  mocks.workspace.sandboxProject = SANDBOX_PROJECT;
  mocks.workspace.productionProject = PRODUCTION_PROJECT;
  mocks.workspace.isProjectSwitching = false;
  mocks.deployment.sandboxOnly = false;
  mocks.selectProject.mockReset();
  vi.mocked(vi.spyOn(workspaceContext, "useDashboardWorkspace"), {
    partial: true,
  }).mockImplementation(() => ({ ...mocks.workspace, selectProject: mocks.selectProject }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NetworkToggle", () => {
  it("checks the current network and switches to the other network's project", async () => {
    show(SANDBOX_PROJECT);
    renderToggle();
    const devnet = screen.getByRole("radio", { name: "Devnet" });
    const mainnet = screen.getByRole("radio", { name: "Mainnet" });
    expect(screen.getByRole("group", { name: "Network" })).toBeDefined();
    expect((devnet as HTMLInputElement).checked).toBe(true);
    expect((mainnet as HTMLInputElement).checked).toBe(false);

    await userEvent.setup().click(mainnet);

    expect(mocks.selectProject).toHaveBeenCalledWith(PRODUCTION_PROJECT.id);
  });

  it("switches back to devnet from mainnet", async () => {
    show(PRODUCTION_PROJECT);
    renderToggle();

    await userEvent.setup().click(screen.getByRole("radio", { name: "Devnet" }));

    expect(mocks.selectProject).toHaveBeenCalledWith(SANDBOX_PROJECT.id);
  });

  it("opens the mainnet request in Settings while mainnet is not approved", async () => {
    mocks.workspace.productionProject = null;
    show(SANDBOX_PROJECT);
    renderToggle();

    await userEvent.setup().click(screen.getByRole("radio", { name: "Mainnet" }));

    expect(mocks.selectProject).not.toHaveBeenCalled();
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      `/dashboard/${SANDBOX_PROJECT.id}/settings#mainnet-access`
    );
  });

  it("holds while a switch is in flight", () => {
    mocks.workspace.isProjectSwitching = true;
    show(SANDBOX_PROJECT);
    renderToggle();

    expect((screen.getByRole("group", { name: "Network" }) as HTMLFieldSetElement).disabled).toBe(
      true
    );
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
