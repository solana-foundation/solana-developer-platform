// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as membersActions from "@/app/(session)/members/actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
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
  });

  it.each([
    { status: 500, shown: "Could not send the invitation. Try again in a moment." },
    { status: null, shown: "Could not send the invitation. Try again in a moment." },
    { status: 409, shown: "Could not send the invitation: An internal error occurred" },
  ])("shows a $status refusal's own message only below 500", async ({ status, shown }) => {
    const error = vi.spyOn(toast, "error");
    vi.spyOn(membersActions, "inviteMember").mockResolvedValue({
      status: "error",
      message: "An internal error occurred",
      answer: { status, replayed: false, code: null },
    });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <InviteMemberForm />
      </I18nProvider>
    );

    await user.type(screen.getByRole("textbox", { name: "Email address" }), "a@example.com");
    await user.click(await screen.findByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith(shown));
  });

  it("says no email went out when the address already holds the organization", async () => {
    const success = vi.spyOn(toast, "success");
    vi.spyOn(membersActions, "inviteMember").mockResolvedValue({
      status: "success",
      email: "a@example.com",
      emailSent: false,
    });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <InviteMemberForm />
      </I18nProvider>
    );

    await user.type(screen.getByRole("textbox", { name: "Email address" }), "a@example.com");
    await user.click(await screen.findByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(expect.stringContaining("no email was sent"))
    );
  });
});
