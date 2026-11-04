// @vitest-environment jsdom

import * as clerk from "@clerk/nextjs";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspace from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { WorkspaceSwitcher } from "./workspace-switcher";

const mocks = {
  setActive: vi.fn(),
  toastError: vi.fn(),
  switching: vi.fn(),
};

function organizationState(isLoaded = true) {
  vi.mocked(vi.spyOn(clerk, "useOrganization"), { partial: true, deep: true }).mockReturnValue({
    isLoaded,
    organization: { id: "org_a", name: "Alpha", imageUrl: "" },
  });
}

function fixture() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WorkspaceSwitcher onOrganizationSwitchingChange={mocks.switching} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  organizationState();
  vi.spyOn(toast, "error").mockImplementation(mocks.toastError);
  vi.mocked(vi.spyOn(clerk, "useOrganizationList"), { partial: true, deep: true }).mockReturnValue({
    isLoaded: true,
    setActive: mocks.setActive,
    userMemberships: {
      data: ["Alpha", "Beta"].map((name, index) => ({
        organization: { id: index === 0 ? "org_a" : "org_b", name, imageUrl: "" },
      })),
    },
  });
  vi.mocked(vi.spyOn(workspace, "useDashboardWorkspace"), { partial: true }).mockReturnValue({
    projects: [],
    selectedProjectId: "project_a",
    selectProject: vi.fn(),
    isProjectSwitching: false,
  });
  mocks.setActive.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workspace organization switching", () => {
  it("shows a loading placeholder while Clerk resolves the organization", () => {
    organizationState(false);
    fixture();
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("Select organization")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the current organization without restarting the workspace", async () => {
    fixture();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    await user.click(screen.getByRole("menuitem", { name: /Alpha/ }));
    expect(mocks.setActive).not.toHaveBeenCalled();
    expect(mocks.switching).not.toHaveBeenCalled();
  });

  it("shows a pending switch until Clerk has made the organization active", async () => {
    const pending = Promise.withResolvers<void>();
    mocks.setActive.mockReturnValue(pending.promise);
    fixture();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    await user.click(screen.getByRole("menuitem", { name: /Beta/ }));
    expect(mocks.setActive).toHaveBeenCalledWith({ organization: "org_b" });
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-busy")).toBe("true");
    expect(mocks.switching.mock.calls).toEqual([[true]]);
    pending.resolve();
    await waitFor(() => expect(mocks.switching.mock.calls).toEqual([[true], [false]]));
  });

  it("reports a refused switch and makes the current workspace usable again", async () => {
    mocks.setActive.mockRejectedValue(new Error("Switch refused"));
    fixture();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    await user.click(screen.getByRole("menuitem", { name: /Beta/ }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Could not switch organizations. Try again.")
    );
    expect(mocks.switching.mock.calls).toEqual([[true], [false]]);
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-busy")).toBe("false");
  });
});
