// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense, startTransition, use, useState } from "react";
import { toast } from "sonner";
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
  const session: { activeOrganization: { id: string; name: string } | null } = {
    activeOrganization: null,
  };
  return {
    session,
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
    revalidateMemberships: vi.fn(),
    revalidateInvitations: vi.fn(),
  };
});

vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ setActive: mocks.setActive }),
  useOrganization: () => ({ organization: mocks.session.activeOrganization }),
  useOrganizationList: () => ({
    isLoaded: mocks.isLoaded,
    setActive: mocks.setActive,
    userMemberships: {
      data: mocks.memberships,
      fetchNext: mocks.fetchNext,
      hasNextPage: mocks.hasNextPage,
      isFetching: mocks.isFetching,
      revalidate: mocks.revalidateMemberships,
    },
    userInvitations: { data: mocks.invitations, revalidate: mocks.revalidateInvitations },
  }),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function panel(refusedOrganizationId: string | null) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SelectExistingOrganizationPanel refusedOrganizationId={refusedOrganizationId} />
    </I18nProvider>
  );
}

function renderPanel(refusedOrganizationId: string | null = null) {
  return render(panel(refusedOrganizationId));
}

// The dashboard layout across a refresh: Next's refresh is a transition that
// commits only once the server's render arrives, and the layout's answer is the
// organization it refused that time.
const refreshingLayout: { showVerdict: (verdict: Promise<string>) => void } = {
  showVerdict: () => {},
};

function Verdict({ verdict }: { verdict: Promise<string> }) {
  return panel(use(verdict));
}

function RefreshingLayout({ initialRefused }: { initialRefused: string }) {
  const [verdict, setVerdict] = useState(() => Promise.resolve(initialRefused));
  refreshingLayout.showVerdict = setVerdict;
  return (
    <Suspense fallback={null}>
      <Verdict verdict={verdict} />
    </Suspense>
  );
}

function membership(id: string, name: string) {
  return { organization: { id, name, imageUrl: "" } };
}

function choice(name: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name });
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
    mocks.session.activeOrganization = null;
    mocks.revalidateMemberships.mockReset();
    mocks.revalidateInvitations.mockReset();
    vi.restoreAllMocks();
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

  it("with no access, drops the refused organization and offers to create one when nothing remains", () => {
    renderPanel("org_existing");

    expect(screen.getByRole("heading", { name: "No access to Existing workspace" })).toBeTruthy();
    expect(
      screen.getByText(
        "SDP has no active membership for you in this organization. Create your own organization, or ask an admin to invite you."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Existing workspace" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Organization name" })).toBeTruthy();
  });

  it("holds the list until the refreshed layout answers, then unlocks on another refusal", async () => {
    mocks.memberships = [
      membership("org_alpha", "Alpha"),
      membership("org_beta", "Beta"),
      membership("org_gamma", "Gamma"),
    ];
    let answerRefresh: (refusedOrganizationId: string) => void = () => {};
    dashboardRouter.refresh.mockImplementationOnce(() => {
      startTransition(() =>
        refreshingLayout.showVerdict(
          new Promise<string>((resolve) => {
            answerRefresh = resolve;
          })
        )
      );
    });
    await act(async () => {
      render(<RefreshingLayout initialRefused="org_alpha" />);
    });

    await act(async () => {
      choice("Beta").click();
    });
    expect(mocks.setActive).toHaveBeenCalledWith({ organization: "org_beta" });
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
    expect(choice("Gamma").disabled).toBe(true);
    expect(choice("Beta").parentElement?.getAttribute("aria-busy")).toBe("true");

    mocks.session.activeOrganization = { id: "org_beta", name: "Beta" };
    await act(async () => answerRefresh("org_beta"));

    expect(screen.getByRole("heading", { name: "No access to Beta" })).toBeTruthy();
    expect(
      screen.getByText(
        "SDP has no active membership for you in this organization. Choose another organization, or ask an admin to invite you."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
    await waitFor(() => expect(choice("Gamma").disabled).toBe(false));
    expect(choice("Gamma").parentElement?.getAttribute("aria-busy")).toBe("false");
  });

  it("holds every choice while a switch is in flight", async () => {
    const user = userEvent.setup();
    let finishSwitch = () => {};
    mocks.memberships = [membership("org_alpha", "Alpha"), membership("org_beta", "Beta")];
    mocks.setActive.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSwitch = resolve;
      })
    );
    renderPanel();

    await user.click(choice("Alpha"));

    expect(choice("Alpha").disabled).toBe(true);
    expect(choice("Beta").disabled).toBe(true);
    expect(choice("Beta").parentElement?.getAttribute("aria-busy")).toBe("true");
    finishSwitch();
    await waitFor(() => expect(choice("Beta").disabled).toBe(false));
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it("names the refused organization from the session when the loaded list lacks it", () => {
    mocks.session.activeOrganization = { id: "org_unlisted", name: "Unlisted workspace" };
    renderPanel("org_unlisted");

    expect(screen.getByRole("heading", { name: "No access to Unlisted workspace" })).toBeTruthy();
    expect(choice("Existing workspace").disabled).toBe(false);
  });

  it("keeps an accepted invitation accepted when switching to its organization fails", async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(toast, "error");
    const accept = vi.fn(async () => {});
    mocks.memberships = [];
    mocks.invitations = [
      {
        id: "orginv_test",
        publicOrganizationData: { id: "org_invited", name: "Invited workspace", imageUrl: "" },
        accept,
      },
    ];
    mocks.setActive.mockRejectedValue(new Error("switch refused"));
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Join Invited workspace" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "Joined, but could not switch to the organization. Choose it from the list."
      )
    );
    expect(accept).toHaveBeenCalledOnce();
    expect(mocks.revalidateInvitations).toHaveBeenCalledOnce();
    expect(mocks.revalidateMemberships).toHaveBeenCalledOnce();
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();
  });

  it("loads more existing memberships when Clerk has another page", async () => {
    const user = userEvent.setup();
    mocks.hasNextPage = true;
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(mocks.fetchNext).toHaveBeenCalledOnce();
  });
});
