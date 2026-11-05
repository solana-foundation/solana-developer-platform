// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import {
  dashboardErrorResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { LeaveOrganizationSection } from "./leave-organization-section";

const clerk = vi.hoisted(() => ({ setActive: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({ useClerk: () => ({ setActive: clerk.setActive }) }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  resetDashboardNavigation();
  clerk.setActive.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LeaveOrganizationSection", () => {
  it("refreshes the page after a failed leave, since the membership may have ended", async () => {
    const fetchMock = stubDashboardFetch(() => dashboardErrorResponse(503, "upstream unavailable"));
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <LeaveOrganizationSection />
      </I18nProvider>
    );

    await user.click(screen.getByRole("button", { name: "Leave organization" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave organization" });
    await user.click(within(dialog).getByRole("button", { name: "Leave organization" }));

    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalledOnce());
    expect(sentDashboardRequests(fetchMock).map(({ method, path }) => [method, path])).toEqual([
      ["DELETE", "/api/dashboard/members/me"],
    ]);
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });
});
