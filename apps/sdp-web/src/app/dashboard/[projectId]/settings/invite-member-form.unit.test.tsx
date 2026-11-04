// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as membersActions from "@/app/members/actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
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
  vi.restoreAllMocks();
  restoreWindowLocation();
});

describe("InviteMemberForm", () => {
  it("resends a failed invitation under its key, and an edited address under a new one", async () => {
    const invite = vi.spyOn(membersActions, "inviteMember").mockResolvedValue({
      status: "error",
      message: "upstream unavailable",
      answer: { status: 503, replayed: false, code: null },
    });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <InviteMemberForm />
      </I18nProvider>
    );
    const send = async (email: string, calls: number) => {
      const submit = await screen.findByRole("button", { name: "Send invite" });
      const field = screen.getByRole("textbox", { name: "Email address" });
      await user.clear(field);
      await user.type(field, email);
      await user.click(submit);
      await waitFor(() => expect(invite).toHaveBeenCalledTimes(calls));
    };

    await send("invitee@example.com", 1);
    await send("invitee@example.com", 2);
    await send("other@example.com", 3);

    expect(
      invite.mock.calls.map(([formData]) => [formData.get("email"), formData.get("role")])
    ).toEqual([
      ["invitee@example.com", "member"],
      ["invitee@example.com", "member"],
      ["other@example.com", "member"],
    ]);
    const keys = invite.mock.calls.map(([formData]) => formData.get("idempotencyKey"));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it("re-reads the page at the live URL after an invitation, keeping the Members tab", async () => {
    const membersTabUrl = `/dashboard/${SANDBOX_PROJECT.id}/settings?tab=members`;
    window.history.replaceState(null, "", membersTabUrl);
    vi.spyOn(membersActions, "inviteMember").mockResolvedValue({
      status: "success",
      email: "invitee@example.com",
    });
    const user = userEvent.setup();
    render(<InviteMemberForm />, { wrapper: EnglishI18n });

    await user.type(screen.getByRole("textbox", { name: "Email address" }), "invitee@example.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(dashboardRouter.replace).toHaveBeenCalledWith(membersTabUrl, { scroll: false })
    );
  });
});
