// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRequestUrl } from "@/lib/dashboard-request-key";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  readsOf,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { renderBesideReads } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { InviteMemberForm } from "./invite-member-form";
import { membersQueryKeys } from "./members-query-key";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function created(clerkInvitationId: string | null): Response {
  return dashboardDataResponse(201, { invitation: { clerkInvitationId } });
}

async function invite(email: string) {
  const user = userEvent.setup();
  render(<InviteMemberForm />, { wrapper: EnglishI18n });
  await user.type(screen.getByRole("textbox", { name: "Email address" }), email);
  await user.click(screen.getByRole("button", { name: "Send invite" }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  });

  it("sends nothing for an empty address", async () => {
    const fetchMock = stubDashboardFetch(() => created("inv_clerk_1"));

    await invite("   ");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invites the normalized address, says the email went out, and re-reads the members", async () => {
    const directory = membersQueryKeys.directory(
      { projectId: SANDBOX_PROJECT.id, mode: "live" },
      { page: 1 }
    );
    const success = vi.spyOn(toast, "success");
    const fetchMock = stubDashboardFetch(() => created("inv_clerk_1"));
    const user = userEvent.setup();
    renderBesideReads(<InviteMemberForm />, [directory]);
    await user.type(screen.getByRole("textbox", { name: "Email address" }), " Invitee@Example.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(readsOf(fetchMock, dashboardRequestUrl(directory))).toBe(2));
    expect(
      sentDashboardRequests(fetchMock)
        .filter(({ method }) => method === "POST")
        .map((request) => request.body)
    ).toEqual([{ email: "invitee@example.com", role: "member" }]);
    expect(success).toHaveBeenCalledWith("Invitation sent to invitee@example.com.");
  });

  it("says no email went out when the address already holds the organization", async () => {
    const success = vi.spyOn(toast, "success");
    stubDashboardFetch(() => created(null));

    await invite("a@example.com");

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(expect.stringContaining("no email was sent"))
    );
  });

  it.each<[string, () => Promise<Response>, string]>([
    [
      "500",
      async () => dashboardErrorResponse(500, "An internal error occurred"),
      "Could not send the invitation. Try again in a moment.",
    ],
    [
      "network failure",
      async () => Promise.reject(new TypeError("Failed to fetch")),
      "Could not send the invitation. Try again in a moment.",
    ],
    [
      "409",
      async () => dashboardErrorResponse(409, "An internal error occurred"),
      "Could not send the invitation: An internal error occurred",
    ],
  ])("shows a %s answer's own message only below 500", async (_answer, answer, shown) => {
    const error = vi.spyOn(toast, "error");
    stubDashboardFetch(answer);

    await invite("a@example.com");

    await waitFor(() => expect(error).toHaveBeenCalledWith(shown));
  });
});
