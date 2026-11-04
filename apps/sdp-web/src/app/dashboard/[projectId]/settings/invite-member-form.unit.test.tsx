// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { InviteMemberForm } from "./invite-member-form";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreWindowLocation();
});

describe("InviteMemberForm", () => {
  it("resends a failed invitation under its key, and an edited address under a new one", async () => {
    const fetchMock = stubDashboardFetch(() => dashboardErrorResponse(503, "upstream unavailable"));
    const user = userEvent.setup();
    render(<InviteMemberForm />, { wrapper: EnglishI18n });
    const send = async (email: string, calls: number) => {
      const submit = await screen.findByRole("button", { name: "Send invite" });
      const field = screen.getByRole("textbox", { name: "Email address" });
      await user.clear(field);
      await user.type(field, email);
      await user.click(submit);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
    };

    await send("invitee@example.com", 1);
    await send("invitee@example.com", 2);
    await send("other@example.com", 3);

    const sent = sentDashboardRequests(fetchMock);
    expect(sent.map(({ path, method, body }) => [method, path, body])).toEqual([
      ["POST", "/api/dashboard/members/invite", { email: "invitee@example.com", role: "member" }],
      ["POST", "/api/dashboard/members/invite", { email: "invitee@example.com", role: "member" }],
      ["POST", "/api/dashboard/members/invite", { email: "other@example.com", role: "member" }],
    ]);
    const keys = sent.map((request) => request.idempotencyKey);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it("sends nothing for an empty address", async () => {
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(201, {}));
    const user = userEvent.setup();
    render(<InviteMemberForm />, { wrapper: EnglishI18n });

    await user.type(screen.getByRole("textbox", { name: "Email address" }), "   ");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invites the normalized address, then re-reads the page keeping the Members tab", async () => {
    const membersTabUrl = `/dashboard/${SANDBOX_PROJECT.id}/settings?tab=members`;
    window.history.replaceState(null, "", membersTabUrl);
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(201, {}));
    const user = userEvent.setup();
    render(<InviteMemberForm />, { wrapper: EnglishI18n });

    await user.type(screen.getByRole("textbox", { name: "Email address" }), " Invitee@Example.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(dashboardRouter.replace).toHaveBeenCalledWith(membersTabUrl, { scroll: false })
    );
    expect(sentDashboardRequests(fetchMock).map((request) => request.body)).toEqual([
      { email: "invitee@example.com", role: "member" },
    ]);
  });
});
