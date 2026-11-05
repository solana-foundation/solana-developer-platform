// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types/custody";
import type { PrivateChannelTokenEligibility } from "@sdp/types/private-channels";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWithdrawalAction: vi.fn(),
  fetchWalletBalancesAction: vi.fn(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("./actions", () => ({
  createWithdrawalAction: mocks.createWithdrawalAction,
}));
vi.mock(
  "@/app/(session)/dashboard/[projectId]/integrations/private-channels/wallet-balances",
  () => ({
    fetchWalletBalancesAction: mocks.fetchWalletBalancesAction,
  })
);
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@sdp/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("@sdp/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@sdp/ui/label", () => ({
  Label: (props: ComponentProps<"label">) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: This test double forwards associations supplied by the component.
    <label {...props} />
  ),
}));
vi.mock("@sdp/ui/select", () => ({
  Select: ({
    ariaLabel,
    children,
    onValueChange,
    value,
  }: {
    ariaLabel?: string;
    children: ReactNode;
    onValueChange?: (value: string | null) => void;
    value?: string | null;
  }) => (
    <select
      aria-label={ariaLabel}
      onChange={(event) => onValueChange?.(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">Select an option</option>
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("./withdraw-progress", () => ({
  WithdrawProgress: () => null,
}));

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import {
  MovementReadsProbe,
  movementReadResponse,
  PRIVATE_CHANNELS_INSTANCE_READ,
  privateChannelMovementFixture,
  WALLET_SUMMARIES_READ,
} from "@/test/private-channels";
import { WithdrawForm } from "./withdraw-form";

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

const eligibleTokens: PrivateChannelTokenEligibility[] = [
  {
    symbol: "USDC",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    enabled: true,
    exclusionReasons: [],
  },
];

const wallets: CustodyWalletSummary[] = [
  {
    id: "custody_treasury",
    custodyConfigId: "custody-config-1",
    isRuntimeExecutionAllowed: true,
    walletId: "wallet_treasury",
    publicKey: "Treasury11111111111111111111111111111111",
    label: "Treasury",
    purpose: null,
    status: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WithdrawForm", () => {
  it("refuses to submit until the user picks the wallet", async () => {
    const user = userEvent.setup();
    render(<WithdrawForm tokens={eligibleTokens} wallets={wallets} />, { wrapper: I18nWrapper });

    await user.type(screen.getByLabelText("Amount (USDC)"), "1.25");
    await user.click(screen.getByRole("button", { name: "Withdraw" }));

    expect(await screen.findByText("Select a wallet to withdraw from.")).toBeTruthy();
    expect(mocks.createWithdrawalAction).not.toHaveBeenCalled();
  });

  it("re-reads Private Channels and custody wallet reads once the withdrawal is accepted", async () => {
    const fetchMock = stubDashboardFetch(({ path }) => movementReadResponse(path));
    mocks.fetchWalletBalancesAction.mockResolvedValue({ channel: null, onChain: null });
    mocks.createWithdrawalAction.mockResolvedValue({
      ok: true,
      withdrawal: privateChannelMovementFixture({ id: "pcw_test_1", status: "submitted" }),
    });
    const user = userEvent.setup();
    render(
      <DashboardReadsProvider>
        <MovementReadsProbe />
        <WithdrawForm tokens={eligibleTokens} wallets={wallets} />
      </DashboardReadsProvider>,
      { wrapper: I18nWrapper }
    );
    const [walletSelect] = screen.getAllByRole("combobox");
    if (!walletSelect) throw new Error("No wallet select rendered");
    await user.selectOptions(walletSelect, "wallet_treasury");
    await user.type(screen.getByLabelText("Amount (USDC)"), "1.25");
    await user.click(screen.getByRole("button", { name: "Withdraw" }));

    await waitFor(() =>
      expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
        PRIVATE_CHANNELS_INSTANCE_READ,
        WALLET_SUMMARIES_READ,
        PRIVATE_CHANNELS_INSTANCE_READ,
        WALLET_SUMMARIES_READ,
      ])
    );
  });
});
