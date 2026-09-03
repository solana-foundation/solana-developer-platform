// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { SelectExistingOrganizationPanel } from "./select-existing-organization-panel";

const mocks = vi.hoisted(() => ({
  isLoaded: true,
  memberships: [
    {
      organization: {
        id: "org_existing",
        name: "Existing workspace",
        imageUrl: "",
      },
    },
  ],
  fetchNext: vi.fn(),
  hasNextPage: false,
  isFetching: false,
  clearSelectedProject: vi.fn(),
  refresh: vi.fn(),
  setActive: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useOrganizationList: () => ({
    isLoaded: mocks.isLoaded,
    setActive: mocks.setActive,
    userMemberships: {
      data: mocks.memberships,
      fetchNext: mocks.fetchNext,
      hasNextPage: mocks.hasNextPage,
      isFetching: mocks.isFetching,
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/lib/project-cookie-action", () => ({
  selectProjectAction: mocks.clearSelectedProject,
}));

function renderPanel() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SelectExistingOrganizationPanel />
    </I18nProvider>
  );
}

describe("SelectExistingOrganizationPanel", () => {
  beforeEach(() => {
    cleanup();
    mocks.isLoaded = true;
    mocks.memberships = [
      {
        organization: {
          id: "org_existing",
          name: "Existing workspace",
          imageUrl: "",
        },
      },
    ];
    mocks.fetchNext.mockReset();
    mocks.hasNextPage = false;
    mocks.isFetching = false;
    mocks.clearSelectedProject.mockReset();
    mocks.clearSelectedProject.mockResolvedValue(undefined);
    mocks.refresh.mockReset();
    mocks.setActive.mockReset();
    mocks.setActive.mockResolvedValue(undefined);
  });

  it("offers existing memberships without an organization creation action", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: "Existing workspace" })).toBeTruthy();
    expect(screen.queryByText(/create organization/i)).toBeNull();
  });

  it("activates the selected membership and refreshes the server layout", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Existing workspace" }));

    expect(mocks.clearSelectedProject).toHaveBeenCalledWith(null);
    expect(mocks.setActive).toHaveBeenCalledWith({ organization: "org_existing" });
    expect(mocks.clearSelectedProject.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setActive.mock.invocationCallOrder[0]
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("does not offer organization creation when no memberships exist", () => {
    mocks.memberships = [];
    renderPanel();

    expect(screen.getByText("No organizations yet.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("loads more existing memberships when Clerk has another page", async () => {
    const user = userEvent.setup();
    mocks.hasNextPage = true;
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(mocks.fetchNext).toHaveBeenCalledOnce();
  });
});
