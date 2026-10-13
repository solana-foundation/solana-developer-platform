// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { WalletPageView } from "./wallet-detail.shared";

const mocks = vi.hoisted(() => ({
  updateLabel: vi.fn(async (_walletId: string, label: string, _key?: string) => ({
    status: "success" as const,
    label,
  })),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("../actions", () => ({ updateWalletLabelAction: mocks.updateLabel }));
vi.mock("../use-wallet-actions", () => ({
  useWalletActions: () => ({
    isBusy: false,
    canRunSignerCheck: false,
    runSignerCheck: () => undefined,
    lastProof: null,
  }),
}));

const { WalletSettingsTab } = await import("./wallet-settings-tab");

const WALLET: WalletPageView = {
  walletId: "wal_settings_test",
  custodyWalletId: "cw_settings_test",
  name: "Treasury",
  publicKey: "11111111111111111111111111111111",
  provider: "turnkey",
  providerName: "Turnkey",
  purposeLabel: null,
  createdAt: null,
  isRuntimeExecutionAllowed: true,
  supportsSignerCheck: false,
  connection: null,
  canManageCustody: true,
  label: "Treasury",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WalletSettingsTab label", () => {
  it("saves the label under an Idempotency-Key, and a retry after a lost answer reuses it", async () => {
    mocks.updateLabel.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <WalletSettingsTab wallet={WALLET} />
      </I18nProvider>
    );
    fireEvent.change(screen.getByLabelText("Wallet label"), {
      target: { value: "Settlement" },
    });
    const save = screen.getByRole("button", { name: "Save changes" });
    await act(async () => {
      fireEvent.click(save);
    });
    await act(async () => {
      fireEvent.click(save);
    });

    const [first, retry] = mocks.updateLabel.mock.calls;
    expect(first?.slice(0, 2)).toEqual(["wal_settings_test", "Settlement"]);
    expect(first?.[2]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(retry?.[2]).toBe(first?.[2]);
  });
});
