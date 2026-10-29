// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as membersActions from "@/app/members/actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { LeaveOrganizationCard } from "./leave-organization-card";

const clerk = vi.hoisted(() => ({ setActive: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({ useClerk: () => ({ setActive: clerk.setActive }) }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  resetDashboardNavigation();
  clerk.setActive.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LeaveOrganizationCard", () => {
  it("refreshes the page after a failed leave, since the membership may have ended", async () => {
    vi.spyOn(membersActions, "leaveOrganization").mockResolvedValue({
      status: "error",
      message: "upstream unavailable",
      answer: { status: 503, replayed: false, code: null },
    });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <LeaveOrganizationCard />
      </I18nProvider>
    );

    await user.click(screen.getByRole("button", { name: "Leave organization" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave organization" });
    await user.click(within(dialog).getByRole("button", { name: "Leave organization" }));

    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalledOnce());
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });
});
