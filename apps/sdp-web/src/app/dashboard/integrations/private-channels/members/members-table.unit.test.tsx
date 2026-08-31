// @vitest-environment jsdom

import type { PrivateChannelPrincipalDto } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
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

describe("Private Channels principals table", () => {
  it("shows the automatic default principal", () => {
    renderTable(principalFixture());
    expect(screen.getAllByText("Default")).toHaveLength(2);
    expect(screen.getByText("1 principal for this project.")).toBeDefined();
  });

  it("shows an additional named principal", () => {
    renderTable(principalFixture({ name: "EU treasury", isDefault: false }));
    expect(screen.getByText("EU treasury")).toBeDefined();
    expect(screen.getByText("Additional")).toBeDefined();
  });
});
