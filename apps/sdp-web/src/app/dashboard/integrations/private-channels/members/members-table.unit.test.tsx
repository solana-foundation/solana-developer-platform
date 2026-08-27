// @vitest-environment jsdom

import type { PrivateChannelUserDto } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("./actions", () => ({
  addToChannelAction: vi.fn(),
  deleteMemberAction: vi.fn(),
  inviteMemberAction: vi.fn(),
  removeFromChannelAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MembersTable } from "./members-table";

const REVOKED_TOOLTIP = "Project membership revoked — remove this member";

function memberFixture(overrides: Partial<PrivateChannelUserDto> = {}): PrivateChannelUserDto {
  return {
    id: "pcu_1",
    userId: "usr_1",
    email: "alice@example.com",
    name: "Alice",
    projectRole: "developer",
    verifiedWalletCount: 0,
    invitedAt: "2026-07-31T00:00:00.000Z",
    channels: [],
    ...overrides,
  };
}

function renderTable(member: PrivateChannelUserDto) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <MembersTable members={[member]} channels={[]} eligibleProjectMembers={[]} />
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("MembersTable role column", () => {
  it("shows the project role capitalized for active members", () => {
    renderTable(memberFixture({ projectRole: "admin" }));
    expect(screen.getByText("admin")).toBeDefined();
    expect(screen.queryByText(REVOKED_TOOLTIP)).toBeNull();
  });

  it("flags a revoked-membership row with the warning tooltip", () => {
    renderTable(memberFixture({ projectRole: null }));
    // sr-only label + TooltipContent both render the string; either presence proves the branch.
    expect(screen.getAllByText(REVOKED_TOOLTIP).length).toBeGreaterThan(0);
  });
});
