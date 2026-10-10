// @vitest-environment jsdom

import { getPermissionsForApiKeyRole, type PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { saveApiKeyAuthoringAction } from "./actions";
import type { ApiKeyAuthoringExistingKey } from "./api-key-authoring";
import { ApiKeyAuthoringWorkspace } from "./api-key-authoring-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "prj_test_sandbox",
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

const WALLET_A: PaymentsDashboardWallet = {
  id: "wallet_a",
  walletId: "wallet_a",
  publicKey: "So11111111111111111111111111111111111111112",
  label: "Treasury",
  isRuntimeExecutionAllowed: true,
};
const WALLET_B: PaymentsDashboardWallet = {
  ...WALLET_A,
  id: "wallet_b",
  walletId: "wallet_b",
  label: "Ops",
};
const WALLETS = [WALLET_A, WALLET_B];

async function openPermissionsStep(wallets: PaymentsDashboardWallet[] = WALLETS) {
  const user = userEvent.setup();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApiKeyAuthoringWorkspace mode="create" wallets={wallets} />
    </I18nProvider>
  );
  await user.type(screen.getByLabelText("Name"), "Partner backend");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

async function openAccessStep() {
  const user = await openPermissionsStep();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ApiKeyAuthoringWorkspace permissions", () => {
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

    await user.click(screen.getByRole("radio", { name: /^Admin/ }));
    expect(screen.getByText("Full endpoint access")).toBeTruthy();
    expect(screen.queryByRole("list", { name: PERMISSION_LIST_NAME })).toBeNull();
  });

  it("repeats the granted list on the review step", async () => {
    const user = await openPermissionsStep();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    const chips = permissionChips();
    expect(chips).toEqual([...getPermissionsForApiKeyRole("api_developer")]);
    expect(chips).toContain("earn:write");
  });
});

const EXISTING_KEY: ApiKeyAuthoringExistingKey = {
  id: "key_1",
  name: "Partner backend",
  role: "api_developer",
  environment: "sandbox",
  permissions: null,
  expiresAt: null,
  walletScope: "selected",
  signingWalletId: "wallet_a",
  signingWalletIds: ["wallet_a"],
  allowedOperations: [],
};

function familyBox(name: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("checkbox", { name });
}

describe("ApiKeyAuthoringWorkspace allowed operations", () => {
  it("starts unrestricted, with no operation list to fill in", async () => {
    await openAccessStep();

    expect(screen.getByRole<HTMLInputElement>("radio", { name: /^All operations/ }).checked).toBe(
      true
    );
    expect(screen.queryByRole("checkbox", { name: "Payments" })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(
      false
    );
  });

  it("asks for at least one operation once the key is limited, and blocks Continue until then", async () => {
    const user = await openAccessStep();

    await user.click(screen.getByRole("radio", { name: /^Only selected operations/ }));

    for (const family of ["Payments", "Ramps", "Issuance", "Program interactions", "Privacy"]) {
      expect(familyBox(family).checked).toBe(false);
    }
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(true);
    expect(
      screen.getByText("Select at least one operation, or allow all operations.")
    ).toBeTruthy();

    await user.click(familyBox("Payments"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(
      false
    );
    expect(
      screen.queryByText("Select at least one operation, or allow all operations.")
    ).toBeNull();
  });

  it("shows a ticked family's types, all ticked, and narrows to the remaining types", async () => {
    const user = await openAccessStep();
    await user.click(screen.getByRole("radio", { name: /^Only selected operations/ }));
    await user.click(familyBox("Ramps"));

    const onramp = screen.getByRole<HTMLInputElement>("checkbox", { name: "ramp_onramp_quote" });
    const offramp = screen.getByRole<HTMLInputElement>("checkbox", { name: "ramp_offramp_quote" });
    expect(onramp.checked).toBe(true);
    expect(offramp.checked).toBe(true);

    await user.click(onramp);

    expect(onramp.checked).toBe(false);
    expect(offramp.checked).toBe(true);
    // Only part of the family is ticked, so the family box shows a dash, not a tick.
    expect(familyBox("Ramps").checked).toBe(false);
    expect(familyBox("Ramps").indeterminate).toBe(true);
  });

  it("hides a family's types until the family is ticked", async () => {
    const user = await openAccessStep();
    await user.click(screen.getByRole("radio", { name: /^Only selected operations/ }));

    expect(screen.queryByRole("checkbox", { name: "ramp_onramp_quote" })).toBeNull();
    await user.click(familyBox("Ramps"));
    expect(screen.getByRole("checkbox", { name: "ramp_onramp_quote" })).toBeTruthy();
    await user.click(familyBox("Ramps"));
    expect(screen.queryByRole("checkbox", { name: "ramp_onramp_quote" })).toBeNull();
  });

  it("repeats the choice on the review step", async () => {
    const user = await openAccessStep();
    await user.click(screen.getByRole("radio", { name: /^Only selected operations/ }));
    await user.click(familyBox("Payments"));
    await user.click(familyBox("Ramps"));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getAllByText("Payments, Ramps").length).toBeGreaterThan(0);
  });

  it("saves the ticked operations with the key", async () => {
    vi.mocked(saveApiKeyAuthoringAction).mockResolvedValue({ ok: true, message: "Saved" });
    const user = await openAccessStep();
    await user.click(screen.getByRole("radio", { name: /^Only selected operations/ }));
    await user.click(familyBox("Payments"));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(saveApiKeyAuthoringAction).toHaveBeenCalledTimes(1);
    expect(saveApiKeyAuthoringAction).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "create",
        draft: expect.objectContaining({
          name: "Partner backend",
          operationsScope: "selected",
          selectedOperations: ["payment"],
        }),
      })
    );
  });

  it("saves an unrestricted key without a list", async () => {
    vi.mocked(saveApiKeyAuthoringAction).mockResolvedValue({ ok: true, message: "Saved" });
    const user = await openAccessStep();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(saveApiKeyAuthoringAction).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ operationsScope: "all", selectedOperations: [] }),
      })
    );
  });

  it("opens an existing restricted key on its own list", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiKeyAuthoringWorkspace
          mode="edit"
          wallets={WALLETS}
          initialKey={{ ...EXISTING_KEY, allowedOperations: ["payment", "ramp_offramp_quote"] }}
        />
      </I18nProvider>
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: /^Only selected operations/ }).checked
    ).toBe(true);
    expect(familyBox("Payments").checked).toBe(true);
    expect(familyBox("Ramps").indeterminate).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "ramp_offramp_quote" }).checked
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "ramp_onramp_quote" }).checked
    ).toBe(false);
  });

  it("opens an existing unrestricted key on All operations", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiKeyAuthoringWorkspace mode="edit" wallets={WALLETS} initialKey={EXISTING_KEY} />
      </I18nProvider>
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole<HTMLInputElement>("radio", { name: /^All operations/ }).checked).toBe(
      true
    );
  });
});
