// @vitest-environment jsdom

import type { CustodyWalletSummary, PrivateChannelTokenEligibility } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDepositAction: vi.fn(),
  fetchWalletBalancesAction: vi.fn(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("./actions", () => ({
  createDepositAction: mocks.createDepositAction,
}));
vi.mock("../wallet-balances", () => ({
  fetchWalletBalancesAction: mocks.fetchWalletBalancesAction,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@/components/ui/label", () => ({
  Label: (props: ComponentProps<"label">) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: This test double forwards associations supplied by the component.
    <label {...props} />
  ),
}));
vi.mock("@/components/ui/select", () => ({
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
vi.mock("./deposit-progress", () => ({
  DepositProgress: () => null,
}));

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DepositForm } from "./deposit-form";

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
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DepositForm", () => {
  it("refuses to submit until the user picks the wallet", async () => {
    const user = userEvent.setup();
    render(<DepositForm tokens={eligibleTokens} wallets={wallets} />, { wrapper: I18nWrapper });

    await user.type(screen.getByLabelText("Amount (USDC)"), "1.25");
    await user.click(screen.getByRole("button", { name: "Deposit" }));

    expect(await screen.findByText("Select a wallet to deposit from.")).toBeTruthy();
    expect(mocks.createDepositAction).not.toHaveBeenCalled();
  });
});
