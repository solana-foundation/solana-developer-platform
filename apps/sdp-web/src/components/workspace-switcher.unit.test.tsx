// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import * as unlinkedOrganizations from "@/lib/use-unlinked-organizations";
import { WorkspaceSwitcher } from "./workspace-switcher";

const mocks = vi.hoisted(() => ({
  releaseChannel: "stable" as string,
  unlinkedIds: new Set<string>() as ReadonlySet<string>,
}));

vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({
    organization: { id: "org_prod", name: "Prod workspace", imageUrl: "" },
  }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: vi.fn(),
    userMemberships: {
      data: [
        { organization: { id: "org_prod", name: "Prod workspace", imageUrl: null } },
        { organization: { id: "org_beta", name: "Beta workspace", imageUrl: null } },
      ],
    },
  }),
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    flags: { releaseChannel: mocks.releaseChannel },
    projects: [],
    selectedProjectId: null,
    selectProject: vi.fn(),
    isProjectSwitching: false,
  }),
}));

function renderSwitcher() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WorkspaceSwitcher />
    </I18nProvider>
  );
}

describe("WorkspaceSwitcher", () => {
  beforeEach(() => {
    cleanup();
    mocks.releaseChannel = "stable";
    mocks.unlinkedIds = new Set();
    vi.restoreAllMocks();
    vi.spyOn(unlinkedOrganizations, "useUnlinkedOrganizations").mockImplementation(() => ({
      unlinkedIds: mocks.unlinkedIds,
      isResolved: true,
    }));
  });

  it("does not list an organization this deployment does not link", async () => {
    mocks.unlinkedIds = new Set(["org_beta"]);
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole("button", { name: "Prod workspace" }));

    expect(screen.getByRole("menuitem", { name: /Prod workspace/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Beta workspace/ })).toBeNull();
  });

  it("marks the beta deployment beside the organization's name", () => {
    mocks.releaseChannel = "beta";
    renderSwitcher();

    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("shows no beta mark elsewhere", () => {
    renderSwitcher();

    expect(screen.queryByText("Beta")).toBeNull();
  });
});
