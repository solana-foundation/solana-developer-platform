// @vitest-environment jsdom

import type { Project } from "@sdp/types/projects";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspaceContext from "@/contexts/dashboard-workspace-context";
import * as unlinkedOrganizations from "@/lib/use-unlinked-organizations";
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
    flags: { releaseChannel: string };
  } = {
    sandboxProject: null,
    productionProject: null,
    sdpEnvironment: "sandbox",
    selectedProjectId: "",
    isProjectSwitching: false,
    flags: { releaseChannel: "stable" },
  };
  return {
    workspace,
    organizationLoaded: true,
    selectProject: vi.fn(),
    setActive: vi.fn<(params: { organization: string }) => Promise<void>>(),
    switching: vi.fn<(isSwitching: boolean) => void>(),
    acme: { id: "org_test_acme", name: "Acme", imageUrl: null },
    globex: { id: "org_test_globex", name: "Globex", imageUrl: null },
  };
});

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ isLoaded: mocks.organizationLoaded, organization: mocks.acme }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: mocks.setActive,
    userMemberships: { data: [{ organization: mocks.acme }, { organization: mocks.globex }] },
  }),
}));

function showProject(project: Project) {
  setDashboardUrl(`/dashboard/${project.id}/payments`, {});
  mocks.workspace.selectedProjectId = project.id;
  mocks.workspace.sdpEnvironment = project.environment;
}

function renderSwitcher() {
  render(<WorkspaceSwitcher onOrganizationSwitchingChange={mocks.switching} />, {
    wrapper: EnglishI18n,
  });
}

async function openSwitcher() {
  const user = userEvent.setup();
  renderSwitcher();
  const trigger = screen.getByRole("button", { name: "Acme" });
  await user.click(trigger);
  return { user, trigger };
}

function unlinkedState(unlinkedIds: ReadonlySet<string> = new Set()) {
  vi.spyOn(unlinkedOrganizations, "useUnlinkedOrganizations").mockReturnValue({
    unlinkedIds,
    isResolved: true,
  });
}

beforeEach(() => {
  mocks.workspace.sandboxProject = SANDBOX_PROJECT;
  mocks.workspace.productionProject = PRODUCTION_PROJECT;
  mocks.organizationLoaded = true;
  mocks.workspace.flags = { releaseChannel: "stable" };
  mocks.selectProject.mockReset();
  mocks.switching.mockReset();
  mocks.setActive.mockReset();
  mocks.setActive.mockResolvedValue(undefined);
  vi.mocked(vi.spyOn(workspaceContext, "useDashboardWorkspace"), {
    partial: true,
  }).mockImplementation(() => ({
    ...mocks.workspace,
    flags: mocks.workspace.flags as ReturnType<
      typeof workspaceContext.useDashboardWorkspace
    >["flags"],
    selectProject: mocks.selectProject,
  }));
  unlinkedState();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it("shows a loading placeholder while Clerk resolves the organization", () => {
    mocks.organizationLoaded = false;
    showProject(SANDBOX_PROJECT);
    renderSwitcher();

    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the current organization without restarting the workspace", async () => {
    showProject(SANDBOX_PROJECT);
    const { user } = await openSwitcher();

    await user.click(screen.getByRole("menuitem", { name: /Acme$/ }));

    expect(mocks.setActive).not.toHaveBeenCalled();
    expect(mocks.switching).not.toHaveBeenCalled();
  });

  it("shows a pending switch until Clerk has made the organization active", async () => {
    const pending = Promise.withResolvers<void>();
    mocks.setActive.mockReturnValue(pending.promise);
    showProject(SANDBOX_PROJECT);
    const { user, trigger } = await openSwitcher();

    await user.click(screen.getByRole("menuitem", { name: /Globex$/ }));

    expect(mocks.setActive).toHaveBeenCalledExactlyOnceWith({ organization: mocks.globex.id });
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(mocks.switching.mock.calls).toEqual([[true]]);
    pending.resolve();
    await waitFor(() => expect(mocks.switching.mock.calls).toEqual([[true], [false]]));
  });

  it("holds every menu item, Organization settings included, while a switch is pending", async () => {
    mocks.setActive.mockReturnValue(Promise.withResolvers<void>().promise);
    showProject(SANDBOX_PROJECT);
    const { user, trigger } = await openSwitcher();

    await user.click(screen.getByRole("menuitem", { name: /Globex$/ }));
    await user.click(trigger);

    expect(
      [/Acme$/, /^Sandbox/, "Organization settings"].map((name) =>
        screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")
      )
    ).toEqual(["true", "true", "true"]);
  });

  it("reports a refused switch and makes the current workspace usable again", async () => {
    const toastError = vi.spyOn(toast, "error");
    mocks.setActive.mockRejectedValue(new Error("Switch refused"));
    showProject(SANDBOX_PROJECT);
    const { user, trigger } = await openSwitcher();

    await user.click(screen.getByRole("menuitem", { name: /Globex$/ }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not switch organizations. Try again.")
    );
    expect(mocks.switching.mock.calls).toEqual([[true], [false]]);
    expect(trigger.getAttribute("aria-busy")).toBe("false");
  });

  it("does not list an organization this deployment does not link", async () => {
    unlinkedState(new Set([mocks.globex.id]));
    showProject(SANDBOX_PROJECT);
    await openSwitcher();

    expect(screen.getByRole("menuitem", { name: /Acme$/ })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: /Globex$/ })).toBeNull();
  });

  it("marks the beta deployment beside the organization's name", () => {
    mocks.workspace.flags = { releaseChannel: "beta" };
    showProject(SANDBOX_PROJECT);
    renderSwitcher();

    expect(within(screen.getByRole("button", { name: "Acme" })).getByText("Beta")).toBeDefined();
  });

  it("shows no beta mark elsewhere", () => {
    showProject(SANDBOX_PROJECT);
    renderSwitcher();

    expect(screen.queryByText("Beta")).toBeNull();
  });
});
