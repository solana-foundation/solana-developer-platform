// @vitest-environment jsdom
import type { OrganizationRole } from "@sdp/types/roles";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as membersActions from "@/app/members/actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { MemberActions } from "./member-actions";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const REFUSED: membersActions.MemberActionResult = {
  status: "error",
  message: "upstream unavailable",
  answer: { status: 503, replayed: false, code: null },
};

function row(memberId: string, role: OrganizationRole) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <MemberActions
        memberId={memberId}
        label="Teammate"
        role={role}
        isSelf={false}
        isLastAdmin={false}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MemberActions role change", () => {
  it("keeps a failed change's key for its retry, and gives another role or member a new one", async () => {
    const change = vi.spyOn(membersActions, "changeMemberRole").mockResolvedValue(REFUSED);
    const user = userEvent.setup();
    const choose = async (item: string, calls: number) => {
      const trigger = screen.getByRole("button", { name: "Actions for Teammate" });
      await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
      await user.click(trigger);
      await user.click(await screen.findByRole("menuitem", { name: item }));
      await waitFor(() => expect(change).toHaveBeenCalledTimes(calls));
    };
    const { rerender } = render(row("mem_test_1", "member"));

    await choose("Make admin", 1);
    await choose("Make admin", 2);
    rerender(row("mem_test_1", "admin"));
    await choose("Make member", 3);
    rerender(row("mem_test_2", "member"));
    await choose("Make admin", 4);

    const keys = change.mock.calls.map(([, , key]) => key);
    expect(change.mock.calls.map(([memberId, role]) => [memberId, role])).toEqual([
      ["mem_test_1", "admin"],
      ["mem_test_1", "admin"],
      ["mem_test_1", "member"],
      ["mem_test_2", "admin"],
    ]);
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("MemberActions role choices", () => {
  it("offers every other role, read-only included", async () => {
    const change = vi.spyOn(membersActions, "changeMemberRole").mockResolvedValue(REFUSED);
    const user = userEvent.setup();
    render(row("mem_test_viewer", "member"));

    await user.click(screen.getByRole("button", { name: "Actions for Teammate" }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(["Make admin", "Make read-only", "Remove member"]);

    await user.click(screen.getByRole("menuitem", { name: "Make read-only" }));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
    expect(change.mock.calls[0]?.slice(0, 2)).toEqual(["mem_test_viewer", "viewer"]);
  });
});

describe("MemberActions removal", () => {
  const openRemoval = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Actions for Teammate" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove member" }));
    return within(await screen.findByRole("dialog", { name: "Remove member" }));
  };

  it("holds the removal until the member's keys load", async () => {
    vi.spyOn(membersActions, "listMemberApiKeys").mockReturnValue(
      new Promise<membersActions.MemberApiKey[]>(() => {})
    );
    const user = userEvent.setup();
    render(row("mem_test_keys_pending", "member"));

    const dialog = await openRemoval(user);
    expect(dialog.getByText("Checking the API keys this member created…")).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Remove member" }).hasAttribute("disabled")).toBe(
      true
    );
  });

  it("removes anyway after the keys fail to load", async () => {
    vi.spyOn(membersActions, "listMemberApiKeys").mockRejectedValue(new Error("unavailable"));
    const remove = vi.spyOn(membersActions, "removeMember").mockResolvedValue(REFUSED);
    const user = userEvent.setup();
    render(row("mem_test_keys_failed", "member"));

    const dialog = await openRemoval(user);
    await user.click(await dialog.findByRole("button", { name: "Remove anyway" }));
    expect(
      dialog.getByText(
        "Could not load the API keys this member created. Removing them does not revoke their keys."
      )
    ).toBeTruthy();
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith("mem_test_keys_failed", expect.any(String))
    );
  });
});
