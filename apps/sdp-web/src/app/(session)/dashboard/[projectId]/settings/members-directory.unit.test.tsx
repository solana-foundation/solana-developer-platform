// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { MembersDirectory } from "./members-directory";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

type DirectoryMember = ComponentProps<typeof MembersDirectory>["members"][number];
type DirectoryInvitation = ComponentProps<typeof MembersDirectory>["invitations"][number];

function member(id: string, name: string, email: string): DirectoryMember {
  return {
    id,
    identity: { label: name, actionLabel: name, secondary: email, isUnresolved: false },
    role: "member",
    joinedOn: "Nov 4, 2026",
    isSelf: false,
    isLastAdmin: false,
  };
}

const ADA = member("mem_test_ada", "Ada Lovelace", "ada@example.test");
const GRACE = member("mem_test_grace", "Grace Hopper", "grace@example.test");
const INVITATION: DirectoryInvitation = {
  id: "inv_test_1",
  email: "invitee@example.test",
  role: "viewer",
  invitedOn: "Nov 3, 2026",
};

function renderDirectory(
  members: readonly DirectoryMember[],
  invitations: readonly DirectoryInvitation[]
) {
  return render(<MembersDirectory members={members} invitations={invitations} />, {
    wrapper: EnglishI18n,
  });
}

function shownRows(): (string | null)[] {
  return screen
    .queryAllByRole("button", { name: /^Actions for / })
    .map((button) => button.getAttribute("aria-label"));
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
});

describe("MembersDirectory", () => {
  it("narrows the rows to a name or an email, whatever its case", async () => {
    const user = userEvent.setup();
    renderDirectory([ADA, GRACE], [INVITATION]);
    const search = screen.getByRole("searchbox", { name: "Search members" });

    expect(shownRows()).toEqual([
      "Actions for invitee@example.test",
      "Actions for Ada Lovelace",
      "Actions for Grace Hopper",
    ]);
    await user.type(search, "LOVELACE");
    expect(shownRows()).toEqual(["Actions for Ada Lovelace"]);
    await user.clear(search);
    await user.type(search, "grace@");
    expect(shownRows()).toEqual(["Actions for Grace Hopper"]);
    await user.clear(search);
    await user.type(search, "invitee");
    expect(shownRows()).toEqual(["Actions for invitee@example.test"]);
  });

  it("separates members from invitations while invitations exist", async () => {
    const user = userEvent.setup();
    renderDirectory([ADA, GRACE], [INVITATION]);

    await user.click(screen.getByRole("radio", { name: "Members 2" }));
    expect(shownRows()).toEqual(["Actions for Ada Lovelace", "Actions for Grace Hopper"]);
    await user.click(screen.getByRole("radio", { name: "Invited 1" }));
    expect(shownRows()).toEqual(["Actions for invitee@example.test"]);
  });

  it("counts members instead of offering the filter when nobody is invited", () => {
    renderDirectory([ADA, GRACE], []);

    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(screen.getByText("2 members")).toBeTruthy();
  });

  it("names the query nothing matches", async () => {
    const user = userEvent.setup();
    renderDirectory([ADA, GRACE], [INVITATION]);

    await user.type(screen.getByRole("searchbox", { name: "Search members" }), " nobody ");

    expect(screen.getByText("No one matches “nobody”.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps the Invited filter after its last invitation goes, so it can be undone", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDirectory([ADA], [INVITATION]);

    await user.click(screen.getByRole("radio", { name: "Invited 1" }));
    rerender(<MembersDirectory members={[ADA]} invitations={[]} />);

    expect(screen.getByText("No invitations waiting.")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "All 1" }));
    expect(shownRows()).toEqual(["Actions for Ada Lovelace"]);
  });

  it("shows no toolbar for a lone member", () => {
    renderDirectory([ADA], []);

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(shownRows()).toEqual(["Actions for Ada Lovelace"]);
  });
});
