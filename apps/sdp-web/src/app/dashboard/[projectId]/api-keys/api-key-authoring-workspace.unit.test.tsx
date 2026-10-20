// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { isModuleInReleaseChannel, SDP_RAMP_PROVIDER_STAGES } from "@sdp/types/release-channels";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { saveApiKeyAuthoringAction } from "./actions";
import {
  type ApiKeyAuthoringExistingKey,
  everythingGrants,
  grantableActionsInChannel,
} from "./api-key-authoring";
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

// A stable deployment, as production runs (code standards: gate with stable-capped flags).
const STABLE_ACTIONS = grantableActionsInChannel((module) =>
  isModuleInReleaseChannel("stable", module, SDP_RAMP_PROVIDER_STAGES)
);

async function openPermissionsStep(wallets: PaymentsDashboardWallet[] = WALLETS) {
  const user = userEvent.setup();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ApiKeyAuthoringWorkspace mode="create" wallets={wallets} offeredActions={STABLE_ACTIONS} />
    </I18nProvider>
  );
  await user.type(screen.getByLabelText("Name"), "Partner backend");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

async function openAccessStep() {
  const user = await openPermissionsStep();
  await user.click(screen.getByRole("checkbox", { name: "Execute on Transfers" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ApiKeyAuthoringWorkspace permissions", () => {
  it("shows one row per module in the release channel, and none outside it", async () => {
    await openPermissionsStep();

    expect(screen.getByRole("group", { name: "Transfers" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Recurring payments" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Issuance" })).toBeNull();
    expect(screen.queryByRole("group", { name: "API keys" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Configure on/ })).toBeNull();
  });

  it("offers only each module's own verbs", async () => {
    await openPermissionsStep();

    const transfers = within(screen.getByRole("group", { name: "Transfers" }));
    expect(transfers.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual(
      ["Read on Transfers", "Execute on Transfers"]
    );
  });

  it("blocks Continue until something is granted, then shows read as included", async () => {
    const user = await openPermissionsStep();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton.hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: "Manage on Recurring payments" }));
    await user.click(screen.getByRole("checkbox", { name: "Execute on Recurring payments" }));

    const read = screen.getByRole("checkbox", { name: "Read on Recurring payments" });
    expect(read).toHaveProperty("checked", true);
    expect(read.hasAttribute("disabled")).toBe(true);
    expect(continueButton.hasAttribute("disabled")).toBe(false);
  });

  it("saves Everything as the explicit list of offered actions, less included reads", async () => {
    vi.mocked(saveApiKeyAuthoringAction).mockResolvedValue({ ok: true, message: "saved" });
    const user = await openPermissionsStep();
    await user.click(screen.getByRole("button", { name: "Everything" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("radio", { name: /All wallets/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(vi.mocked(saveApiKeyAuthoringAction).mock.calls[0]?.[0].draft.grants).toEqual(
      everythingGrants(STABLE_ACTIONS)
    );
  });

  it("opens an existing key on its own grants", async () => {
    const initialKey: ApiKeyAuthoringExistingKey = {
      id: "key_1",
      name: "Payouts",
      environment: "sandbox",
      grants: ["transfers.execute"],
      expiresAt: null,
      walletScope: "all",
      walletIds: [],
      allowedIps: null,
    };
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiKeyAuthoringWorkspace
          mode="edit"
          wallets={WALLETS}
          offeredActions={STABLE_ACTIONS}
          initialKey={initialKey}
        />
      </I18nProvider>
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const execute = screen.getByRole("checkbox", { name: "Execute on Transfers" });
    expect(execute).toHaveProperty("checked", true);
  });

  it("keeps wallet access on the access step", async () => {
    await openAccessStep();
    expect(screen.getByRole("radio", { name: /Selected wallets/ })).toBeTruthy();
  });

  it("starts a key with an execute grant on selected wallets, until the person picks", async () => {
    await openAccessStep();
    expect(screen.getByRole("radio", { name: /Selected wallets/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  });

  it("starts a read-only key on all wallets", async () => {
    const user = await openPermissionsStep();
    await user.click(screen.getByRole("checkbox", { name: "Read on Transfers" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("radio", { name: /All wallets/ })).toHaveProperty("checked", true);
  });

  it("selects wallets by their custody wallet id", async () => {
    vi.mocked(saveApiKeyAuthoringAction).mockResolvedValue({ ok: true, message: "saved" });
    const user = await openAccessStep();
    await user.click(screen.getByRole("checkbox", { name: /Ops/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));

    const draft = vi.mocked(saveApiKeyAuthoringAction).mock.calls[0]?.[0].draft;
    expect(draft?.walletScope).toBe("selected");
    expect(draft?.selectedWalletIds).toEqual([WALLET_B.id]);
  });
});
