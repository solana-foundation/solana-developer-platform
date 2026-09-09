// @vitest-environment jsdom

import type { PrivateChannelPrincipalDto } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("./actions", () => ({
  addPrincipalToChannelAction: vi.fn(),
  createPrincipalAction: vi.fn(),
  disablePrincipalAction: vi.fn(),
  removePrincipalFromChannelAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MembersTable } from "./members-table";

function principalFixture(
  overrides: Partial<PrivateChannelPrincipalDto> = {}
): PrivateChannelPrincipalDto {
  return {
    id: "pcu_1",
    name: "Default",
    isDefault: true,
    status: "active",
    verifiedWalletCount: 0,
    createdAt: "2026-07-31T00:00:00.000Z",
    channels: [],
    ...overrides,
  };
}

function renderTable(principal: PrivateChannelPrincipalDto) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <MembersTable principals={[principal]} channels={[]} />
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("Private Channels identities table", () => {
  it("shows the automatic default identity", () => {
    renderTable(principalFixture());
    expect(screen.getByText("Default")).toBeDefined();
    expect(screen.getByText("1 identity for this project.")).toBeDefined();
    expect(screen.queryByRole("columnheader", { name: "Type" })).toBeNull();
  });

  it("shows a named identity with an action menu", async () => {
    const user = userEvent.setup();
    renderTable(principalFixture({ name: "EU treasury", isDefault: false }));

    expect(screen.getByText("EU treasury")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Actions for EU treasury" }));
    expect(screen.getByRole("menuitem", { name: "Disable identity" })).toBeDefined();
  });
});
