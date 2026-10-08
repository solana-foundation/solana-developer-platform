// @vitest-environment jsdom

import { getPermissionsForApiKeyRole, type PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { ApiKeyAuthoringExistingKey } from "./api-key-authoring";
import type { ApiKeyAuthoringWallets } from "./api-key-authoring.data";
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

const WITH_POLICIES: ApiKeyAuthoringWallets = { policiesInReleaseChannel: true, wallets: [] };

async function openPermissionsStep(authoringWallets: ApiKeyAuthoringWallets = WITH_POLICIES) {
  const user = userEvent.setup();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApiKeyAuthoringWorkspace mode="create" authoringWallets={authoringWallets} />
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

const RESTRICTED_KEY: ApiKeyAuthoringExistingKey = {
  id: "key_1",
  name: "Partner backend",
  role: "api_developer",
  environment: "sandbox",
  permissions: null,
  expiresAt: null,
  walletScope: "selected",
  signingWalletId: "wallet_a",
  signingWalletIds: ["wallet_a"],
  policyBindings: [
    {
      id: "binding_1",
      bindingScope: "selected",
      walletId: "wallet_a",
      custodyWalletId: null,
      walletControlProfileId: null,
      walletControlProfileRevisionId: null,
      apiKeyControlProfileId: "profile_1",
      apiKeyControlProfileRevisionId: "revision_1",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
  ],
};

function policiesOn(): ApiKeyAuthoringWallets {
  return {
    policiesInReleaseChannel: true,
    wallets: [WALLET_A, WALLET_B].map((wallet) => ({
      ...wallet,
      controlStatus: "default_allow",
      activeRevisionNumber: null,
    })),
  };
}

function policiesOut(): ApiKeyAuthoringWallets {
  return { policiesInReleaseChannel: false, wallets: [WALLET_A, WALLET_B] };
}

async function openRestrictedKeyWalletsStep(authoringWallets: ApiKeyAuthoringWallets) {
  const user = userEvent.setup();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApiKeyAuthoringWorkspace
        mode="edit"
        authoringWallets={authoringWallets}
        initialKey={RESTRICTED_KEY}
      />
    </I18nProvider>
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

const SCOPE_LOCKED =
  "This key has restrictions, so its wallet access can't change while Policies is unavailable. Create a new key instead.";
const RESTRICTIONS_INACTIVE =
  "This key's restrictions are kept but don't apply while Policies is unavailable.";

describe("ApiKeyAuthoringWorkspace without the Policies module", () => {
  it.each([
    ["in", policiesOn(), true],
    ["out of", policiesOut(), false],
  ])(
    "with Policies %s the release channel, wallet controls show: %s",
    async (_, wallets, shown) => {
      const user = await openPermissionsStep(wallets);
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.queryByText("Add API-key restrictions") !== null).toBe(shown);

      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.queryByText("Wallet-control baseline") !== null).toBe(shown);
      expect(screen.queryByText("Wallet control baseline") !== null).toBe(shown);
      expect(screen.queryByText(/Wallet controls always apply/) !== null).toBe(shown);
      expect(screen.queryAllByText(/default allow/i).length > 0).toBe(shown);
    }
  );

  it("says a restricted key's wallet scope is locked and keeps Continue disabled", async () => {
    const user = await openRestrictedKeyWalletsStep(policiesOut());
    expect(screen.getByText(RESTRICTIONS_INACTIVE)).toBeTruthy();
    expect(screen.queryByText(SCOPE_LOCKED)).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Select Ops" }));

    expect(screen.getByText(SCOPE_LOCKED)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(true);
  });

  it("lets the same scope change through when Policies is in the release channel", async () => {
    const user = await openRestrictedKeyWalletsStep(policiesOn());
    await user.click(screen.getByRole("checkbox", { name: "Select Ops" }));

    expect(screen.queryByText(SCOPE_LOCKED)).toBeNull();
    expect(screen.queryByText(RESTRICTIONS_INACTIVE)).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(
      false
    );
  });
});
