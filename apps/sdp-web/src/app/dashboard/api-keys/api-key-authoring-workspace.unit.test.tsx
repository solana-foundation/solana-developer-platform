// @vitest-environment jsdom

import { getPermissionsForApiKeyRole } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ApiKeyAuthoringWorkspace } from "./api-key-authoring-workspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "prj_test",
  }),
}));

vi.mock("./actions", () => ({
  saveApiKeyAuthoringAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/dashboard-quick-start", () => ({
  completeQuickStartStep: vi.fn(),
  quickStartKey: vi.fn(() => "quick-start"),
}));

const PERMISSION_LIST_NAME = "Endpoint permissions";

function permissionChips(): string[] {
  return within(screen.getByRole("list", { name: PERMISSION_LIST_NAME }))
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

/** Fills the details step and lands on the permissions step, where the role cards live. */
async function openPermissionsStep() {
  const user = userEvent.setup();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApiKeyAuthoringWorkspace mode="create" wallets={[]} />
    </I18nProvider>
  );
  await user.type(screen.getByLabelText("Name"), "Partner backend");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ApiKeyAuthoringWorkspace permissions", () => {
  // The Embedded Yield guide tells partners to create a Developer key "with
  // earn:read + earn:write". The wizard has to say so itself, or the partner
  // is left comparing a role name against a permission list they cannot see.
  it("names Earn on the Developer card and lists earn:read and earn:write", async () => {
    await openPermissionsStep();

    const developer = screen.getByRole<HTMLInputElement>("radio", { name: /^Developer/ });
    expect(developer.checked).toBe(true);
    expect(
      screen.getByText(
        "Token, payment, Earn, counterparty, wallet, compliance, and webhook access."
      )
    ).toBeTruthy();

    const chips = permissionChips();
    expect(chips).toEqual([...getPermissionsForApiKeyRole("api_developer")]);
    expect(chips).toContain("earn:read");
    expect(chips).toContain("earn:write");
    expect(screen.getByText(`${chips.length} endpoint permissions`)).toBeTruthy();
  });

  it("follows the selected role: Read only drops the writes, Admin has no list", async () => {
    const user = await openPermissionsStep();

    await user.click(screen.getByRole("radio", { name: /^Read only/ }));
    expect(
      screen.getByText(
        "Read-only token, payment, Earn, counterparty, wallet, compliance, webhook, and audit access."
      )
    ).toBeTruthy();
    const readOnlyChips = permissionChips();
    expect(readOnlyChips).toEqual([...getPermissionsForApiKeyRole("api_readonly")]);
    expect(readOnlyChips).toContain("earn:read");
    expect(readOnlyChips).not.toContain("earn:write");

    // `*` is a sentinel, not a permission to chip: the existing line stands alone.
    await user.click(screen.getByRole("radio", { name: /^Admin/ }));
    expect(screen.getByText("Full endpoint access")).toBeTruthy();
    expect(screen.queryByRole("list", { name: PERMISSION_LIST_NAME })).toBeNull();
  });

  it("repeats the granted list on the review step", async () => {
    const user = await openPermissionsStep();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Past the last "Continue": the primary action is now the create button.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    const chips = permissionChips();
    expect(chips).toEqual([...getPermissionsForApiKeyRole("api_developer")]);
    expect(chips).toContain("earn:write");
  });
});
