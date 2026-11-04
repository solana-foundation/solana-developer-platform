// @vitest-environment jsdom

import type { Project } from "@sdp/types/projects";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { WorkspaceSwitcher } from "./workspace-switcher";

const mocks = vi.hoisted(() => {
  const workspace: {
    sandboxProject: Project | null;
    productionProject: Project | null;
    sdpEnvironment: Project["environment"];
    selectedProjectId: string;
    isProjectSwitching: boolean;
  } = {
    sandboxProject: null,
    productionProject: null,
    sdpEnvironment: "sandbox",
    selectedProjectId: "",
    isProjectSwitching: false,
  };
  return {
    workspace,
    selectProject: vi.fn(),
    acme: { id: "org_test_acme", name: "Acme", imageUrl: null },
    globex: { id: "org_test_globex", name: "Globex", imageUrl: null },
  };
});

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ organization: mocks.acme }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: vi.fn(),
    userMemberships: { data: [{ organization: mocks.acme }, { organization: mocks.globex }] },
  }),
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ ...mocks.workspace, selectProject: mocks.selectProject }),
}));

function showProject(project: Project) {
  setDashboardUrl(`/dashboard/${project.id}/payments`, {});
  mocks.workspace.selectedProjectId = project.id;
  mocks.workspace.sdpEnvironment = project.environment;
}

async function openSwitcher() {
  const user = userEvent.setup();
  render(<WorkspaceSwitcher />, { wrapper: EnglishI18n });
  const trigger = screen.getByRole("button", { name: "Acme" });
  await user.click(trigger);
  return { user, trigger };
}

beforeEach(() => {
  mocks.workspace.sandboxProject = SANDBOX_PROJECT;
  mocks.workspace.productionProject = PRODUCTION_PROJECT;
  mocks.selectProject.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceSwitcher", () => {
  it("marks the active organization and environment, and switches to the other environment", async () => {
    showProject(PRODUCTION_PROJECT);
    const { user, trigger } = await openSwitcher();

    expect(within(trigger).getByText("Production")).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Acme$/ }).getAttribute("aria-current")).toBe(
      "true"
    );
    expect(
      screen.getByRole("menuitem", { name: /Globex$/ }).getAttribute("aria-current")
    ).toBeNull();
    expect(screen.getByText("Environments of Acme")).toBeDefined();
    const production = screen.getByRole("menuitem", { name: /^Production/ });
    const sandbox = screen.getByRole("menuitem", { name: /^Sandbox/ });
    expect(within(production).getByText("Mainnet · real funds")).toBeDefined();
    expect(production.getAttribute("aria-current")).toBe("true");
    expect(within(sandbox).getByText("Devnet · test tokens")).toBeDefined();
    expect(sandbox.getAttribute("aria-current")).toBeNull();

    await user.click(sandbox);

    expect(mocks.selectProject).toHaveBeenCalledExactlyOnceWith(SANDBOX_PROJECT.id);
  });

  it("lists only the environments the organization has", async () => {
    mocks.workspace.productionProject = null;
    showProject(SANDBOX_PROJECT);
    const { trigger } = await openSwitcher();

    expect(within(trigger).getByText("Sandbox")).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /^Sandbox/ }).getAttribute("aria-current")).toBe(
      "true"
    );
    expect(screen.queryByRole("menuitem", { name: /^Production/ })).toBeNull();
  });

  it("links Organization settings inside the URL's Project", async () => {
    showProject(SANDBOX_PROJECT);
    await openSwitcher();

    expect(
      screen.getByRole("menuitem", { name: "Organization settings" }).getAttribute("href")
    ).toBe(`/dashboard/${SANDBOX_PROJECT.id}/settings`);
  });
});
