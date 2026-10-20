// @vitest-environment jsdom

import type { PaymentsDashboardWallet, PaymentTransferSummary } from "@sdp/types/payments";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exceedsWalletBalance } from "@/app/dashboard/[projectId]/payments/ramps/wallet-options";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  type OfframpFinalStepWizard,
  OfframpFooterActionButton,
  OfframpOutcome,
  offrampFooterAction,
} from "./offramp-final-step";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const DEPOSIT_ADDRESS = "2HWz9YwbM56YK1EazmmxFivwRs4n8KND7c1p8eYxS2Ao";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function sale(overrides: Partial<PaymentTransferSummary>): PaymentTransferSummary {
  return {
    id: "xfr_sale",
    custodyWalletId: "cwlt_treasury",
    providerWalletId: "wallet_treasury",
    status: "awaiting_payment",
    signature: null,
    rampsMemo: {},
    type: "offramp",
    provider: "moonpay",
    ...overrides,
  };
}

function finalStep(overrides: Partial<OfframpFinalStepWizard>): OfframpFinalStepWizard {
  return {
    quoteTransferId: "xfr_sale",
    transferStatus: sale({}),
    depositTarget: { destinationAddress: DEPOSIT_ADDRESS, amount: "25" },
    selectedRampPair: { fiatCurrency: "USD", assetRail: "usdc.solana" },
    selectedWallet: { label: "Treasury" },
    canSendOnchain: true,
    onchainSendLoading: false,
    onchainSendResult: null,
    onchainSendError: null,
    sendCryptoToDeposit: vi.fn(async () => undefined),
    startOver: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("off-ramp final step", () => {
  it("links a finished sale to its own transaction, not the contact", () => {
    const wizard = finalStep({ transferStatus: sale({ status: "failed" }) });
    const action = offrampFooterAction(wizard);
    if (action === null) throw new Error("Expected a footer action");

    render(<OfframpFooterActionButton action={action} wizard={wizard} />, { wrapper });

    expect(screen.getByRole("link", { name: "Go to transaction" }).getAttribute("href")).toContain(
      "/payments/transactions/xfr_sale"
    );
  });

  it("shows where the deposit goes before anything is sent", async () => {
    const wizard = finalStep({});
    const action = offrampFooterAction(wizard);
    if (action === null) throw new Error("Expected a footer action");
    render(<OfframpFooterActionButton action={action} wizard={wizard} />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: /Send 25 USDC/ }));

    expect(wizard.sendCryptoToDeposit).not.toHaveBeenCalled();
    expect(screen.getByText("2HWz9Y…S2Ao")).toBeTruthy();
    expect(screen.getByText("Treasury")).toBeTruthy();

    const confirm = screen.getAllByRole("button", { name: /Send 25 USDC/ }).at(-1);
    if (!confirm) throw new Error("Expected the dialog's send button");
    await userEvent.click(confirm);
    expect(wizard.sendCryptoToDeposit).toHaveBeenCalledTimes(1);
  });

  it("explains a failed sale and starts a new payout from the amount", async () => {
    const wizard = finalStep({
      transferStatus: sale({ status: "failed", error: "Deposit timeout" }),
    });
    render(<OfframpOutcome wizard={wizard} />, { wrapper });

    expect(
      screen.getByText("MoonPay reported that this sale failed: Deposit timeout")
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start a new payout" }));
    expect(wizard.startOver).toHaveBeenCalledWith("WITHDRAW");
  });
});

describe("exceedsWalletBalance", () => {
  const wallet: PaymentsDashboardWallet = {
    id: "cwlt_treasury",
    walletId: "wallet_treasury",
    publicKey: "treasury",
    label: "Treasury",
    isRuntimeExecutionAllowed: true,
    balances: [{ token: "USDC", mint: "mint", amount: "5000000", uiAmount: "5", decimals: 6 }],
  };

  it("is true only once the amount is more than the wallet holds", () => {
    expect(exceedsWalletBalance(wallet, "USDC", "25")).toBe(true);
    expect(exceedsWalletBalance(wallet, "USDC", "5")).toBe(false);
    expect(exceedsWalletBalance(wallet, "SOL", "0.1")).toBe(true);
    expect(exceedsWalletBalance(wallet, "USDC", "")).toBe(false);
    expect(exceedsWalletBalance(null, "USDC", "25")).toBe(false);
  });
});
