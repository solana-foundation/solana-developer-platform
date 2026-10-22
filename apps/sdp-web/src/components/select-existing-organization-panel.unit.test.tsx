// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { SelectExistingOrganizationPanel } from "./select-existing-organization-panel";

interface InvitationFixture {
  id: string;
  publicOrganizationData: { id: string; name: string; imageUrl: string };
  accept: () => Promise<void>;
}

const mocks = vi.hoisted(() => {
  const invitations: InvitationFixture[] = [];
  return {
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
    invitations,
    fetchNext: vi.fn(),
    hasNextPage: false,
    isFetching: false,
    setActive: vi.fn(),
  };
});

vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ setActive: mocks.setActive }),
  useOrganizationList: () => ({
    isLoaded: mocks.isLoaded,
    setActive: mocks.setActive,
    userMemberships: {
      data: mocks.memberships,
      fetchNext: mocks.fetchNext,
      hasNextPage: mocks.hasNextPage,
      isFetching: mocks.isFetching,
    },
    userInvitations: { data: mocks.invitations },
  }),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/app/dashboard/create-organization-actions", () => ({ createOrganization: vi.fn() }));

function renderPanel() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SelectExistingOrganizationPanel noAccess={false} />
    </I18nProvider>
  );
}

describe("SelectExistingOrganizationPanel", () => {
  beforeEach(() => {
    cleanup();
    resetDashboardNavigation();
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
    mocks.invitations = [];
    mocks.fetchNext.mockReset();
    mocks.hasNextPage = false;
    mocks.isFetching = false;
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

    expect(mocks.setActive).toHaveBeenCalledWith({ organization: "org_existing" });
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it("offers to create an organization with no memberships and no invitations", () => {
    mocks.memberships = [];
    renderPanel();

    expect(screen.getByRole("heading", { name: "Name your organization" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Organization name" })).toBeTruthy();
  });

  it("accepts a pending invitation before activating its organization", async () => {
    const user = userEvent.setup();
    const accept = vi.fn(async () => {});
    mocks.memberships = [];
    mocks.invitations = [
      {
        id: "orginv_test",
        publicOrganizationData: { id: "org_invited", name: "Invited workspace", imageUrl: "" },
        accept,
      },
    ];
    renderPanel();

    expect(screen.queryByRole("textbox", { name: "Organization name" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Join Invited workspace" }));

    expect(accept).toHaveBeenCalledOnce();
    expect(mocks.setActive).toHaveBeenCalledWith({ organization: "org_invited" });
    expect(accept.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setActive.mock.invocationCallOrder[0]
    );
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it("loads more existing memberships when Clerk has another page", async () => {
    const user = userEvent.setup();
    mocks.hasNextPage = true;
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(mocks.fetchNext).toHaveBeenCalledOnce();
  });
});
