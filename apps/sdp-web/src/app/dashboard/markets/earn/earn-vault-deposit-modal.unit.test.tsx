// @vitest-environment jsdom

import type { EarnStrategy, EarnVaultDeposit, EarnVaultMovementStatus } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnFundingWallet } from "./deposit/earn-funding-wallets";
import {
  EarnVaultDepositModal,
  validateVaultDepositAmount,
  walletBalanceForMint,
} from "./earn-vault-deposit-modal";

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  createEarnVaultDeposit: vi.fn(),
  useEarnFundingWallets: vi.fn(),
}));

const copy = vi.hoisted<Record<string, string>>(() => ({
  "Shared.SharedComponents.closeModal": "Close modal",
  "DashboardEarn.deposit.vaultDepositTitle": "Deposit into {strategy}",
  "DashboardEarn.withdraw.availableChecking": "Checking…",
  "DashboardEarn.withdraw.referenceLabel": "Reference",
  "DashboardEarn.withdraw.done": "Done",
  "DashboardEarn.withdraw.amountLabel": "Amount",
  "DashboardEarn.withdraw.errorAmountRequired": "Enter an amount greater than zero.",
  "DashboardEarn.deposit.cancel": "Cancel",
  "DashboardEarn.deposit.walletsLoadError": "Wallets could not be loaded.",
  "DashboardEarn.deposit.walletsEmptyTitle": "No active custody wallets",
  "DashboardEarn.deposit.walletsEmptyBody": "Create a wallet before depositing.",
  "DashboardEarn.deposit.goToWallets": "Open Wallets",
  "DashboardEarn.deposit.walletUnnamed": "Unnamed wallet",
  "DashboardEarn.deposit.strategyAssetUnavailable": "Strategy asset unavailable.",
  "DashboardEarn.deposit.vaultWalletTitle": "Funding wallet",
  "DashboardEarn.deposit.vaultWalletBody":
    "Choose the custody wallet that will sign and own the vault shares.",
  "DashboardEarn.deposit.vaultAmount": "Amount ({token})",
  "DashboardEarn.deposit.vaultStrategy": "Strategy",
  "DashboardEarn.deposit.vaultBacking": "Backing",
  "DashboardEarn.deposit.vaultFrom": "From",
  "DashboardEarn.deposit.vaultWalletUnavailable": "Signing unavailable",
  "DashboardEarn.deposit.vaultBalanceUnknown": "Balance unavailable",
  "DashboardEarn.deposit.vaultBalanceAvailable": "Available: {amount}",
  "DashboardEarn.deposit.vaultAmountPrecision": "Use no more than {decimals} decimal places.",
  "DashboardEarn.deposit.vaultOverBalance":
    "This is above the last observed balance; the provider will verify it on submit.",
  "DashboardEarn.deposit.vaultConfirmNote":
    "The selected custody wallet signs the vault deposit transaction.",
  "DashboardEarn.deposit.vaultSubmit": "Confirm deposit",
  "DashboardEarn.deposit.vaultSubmitting": "Submitting…",
  "DashboardEarn.deposit.vaultSubmitError": "The deposit could not be submitted.",
  "DashboardEarn.deposit.vaultDoneTitle": "Deposit submitted",
  "DashboardEarn.deposit.vaultDoneBody": "The transaction was submitted to Solana.",
  "DashboardEarn.deposit.vaultSettlingNote":
    "Your vault position will refresh after the chain confirms it.",
  "DashboardEarn.deposit.vaultConfirmedTitle": "Deposit confirmed",
  "DashboardEarn.deposit.vaultConfirmedBody": "The deposit is confirmed on Solana.",
  "DashboardEarn.deposit.vaultConfirmedNote":
    "Your live vault position will refresh automatically.",
  "DashboardEarn.deposit.vaultTransaction": "Transaction",
  "DashboardEarn.deposit.vaultPendingTitle": "Deposit pending",
  "DashboardEarn.deposit.vaultPendingBody": "The transaction is waiting to be submitted.",
  "DashboardEarn.deposit.vaultApprovalTitle": "Approval required",
  "DashboardEarn.deposit.vaultApprovalBody":
    "This deposit has not moved funds. It will execute only after wallet-policy approval.",
  "DashboardEarn.deposit.vaultApprovalRequest": "Approval request",
}));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) => {
    const template = copy[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
      String(values?.[name] ?? `{${name}}`)
    );
  },
  useLocale: () => "en",
}));

vi.mock("./deposit/earn-funding-wallets", () => ({
  walletDisplayName: (wallet: EarnFundingWallet | undefined, fallback: string) =>
    wallet?.label?.trim() || fallback,
  useEarnFundingWallets: mocks.useEarnFundingWallets,
}));

vi.mock("./earn-program-data", () => ({
  createEarnVaultDeposit: mocks.createEarnVaultDeposit,
}));

const strategy: EarnStrategy = {
  id: "strategy_1",
  provider: "kamino",
  providerReference: "vault_1",
  name: "Institutional USDC Vault",
  sourceKind: "defi",
  underlyingSource: "Kamino Lend",
  depositMints: [USDC_MINT],
  shareMint: "Share1111111111111111111111111111111111111",
  apyType: "variable",
  currentApy: "0.061",
  liquidityTerm: "instant",
  status: "active",
  hostCluster: "devnet",
  fundable: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

function fundingWallet(balances: EarnFundingWallet["balances"]): EarnFundingWallet {
  return {
    id: "wallet_1",
    isRuntimeExecutionAllowed: true,
    walletId: "provider_wallet_1",
    publicKey: "7YkWnDF8W6B3gC3xZ1gRzuCUzPmGp7s1e3gHcWw6Xx5p",
    label: "Treasury wallet",
    purpose: "treasury",
    status: "active",
    balances,
  };
}

function vaultDeposit(status: EarnVaultMovementStatus): EarnVaultDeposit {
  return {
    positionId: "position_1",
    movementId: "movement_1",
    status,
    signature: "5R3h9GmTn1pQ7Yv4Jk8Nc2Wx6BdLfUaEoPiSzCvHrKqM",
    failureReason: status === "failed" ? "Provider simulation rejected the transaction" : null,
    replayed: false,
    strategy: {
      id: strategy.id,
      name: strategy.name,
      provider: strategy.provider,
      providerReference: strategy.providerReference,
      hostCluster: strategy.hostCluster,
    },
  };
}

async function enterDepositAmount(amount = "1.000000") {
  const user = userEvent.setup();
  await screen.findByRole("dialog", { name: "Deposit into Institutional USDC Vault" });
  await user.click(screen.getByRole("radio", { name: /Treasury wallet/ }));
  await user.type(screen.getByLabelText("Amount (USDC)"), amount);
  await user.click(screen.getByRole("button", { name: "Confirm deposit" }));
  return user;
}

beforeEach(() => {
  mocks.createEarnVaultDeposit.mockReset();
  mocks.useEarnFundingWallets.mockReset();
  mocks.useEarnFundingWallets.mockReturnValue({
    wallets: [
      fundingWallet([
        { token: "USDC", mint: USDC_MINT, amount: "2500000", uiAmount: "2.5", decimals: 6 },
      ]),
    ],
    error: undefined,
    isLoading: false,
  });
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(IDEMPOTENCY_KEY);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("exact vault amount helpers", () => {
  it("canonicalizes valid input without converting through a number", () => {
    expect(validateVaultDepositAmount("0001.230000", 6)).toEqual({
      kind: "valid",
      canonicalAmount: "1.23",
    });
    expect(validateVaultDepositAmount("1.0000000", 6)).toEqual({
      kind: "valid",
      canonicalAmount: "1",
    });
    expect(validateVaultDepositAmount("9007199254740993.000001", 6)).toEqual({
      kind: "valid",
      canonicalAmount: "9007199254740993.000001",
    });
  });

  it("rejects non-zero digits below one mint atom and unavailable mint scale", () => {
    expect(validateVaultDepositAmount("1.0000001", 6)).toEqual({
      kind: "over_precision",
      decimals: 6,
    });
    expect(validateVaultDepositAmount("1", undefined)).toEqual({ kind: "unknown_scale" });
    for (const amount of ["", "0", "0.000000", "-1", "1e3", ".5"]) {
      expect(validateVaultDepositAmount(amount, 6)).toEqual({ kind: "invalid" });
    }
  });

  it("preserves unknown balances and sums raw mint atoms exactly", () => {
    expect(walletBalanceForMint(fundingWallet(undefined), USDC_MINT, 6)).toBeUndefined();
    expect(walletBalanceForMint(fundingWallet([]), USDC_MINT, 6)).toBe("0");
    expect(
      walletBalanceForMint(
        fundingWallet([
          {
            token: "USDC",
            mint: USDC_MINT,
            amount: "9007199254740993000001",
            uiAmount: "0",
            decimals: 6,
          },
          { token: "USDC", mint: USDC_MINT, amount: "9", uiAmount: "0", decimals: 6 },
        ]),
        USDC_MINT,
        6
      )
    ).toBe("9007199254740993.00001");
  });
});

describe("EarnVaultDepositModal", () => {
  it("reuses one header idempotency key for an identical retry and never sends requestId", async () => {
    const onDeposited = vi.fn();
    mocks.createEarnVaultDeposit
      .mockResolvedValueOnce({
        ok: false,
        error: "Network unavailable",
        status: 503,
        body: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        data: {
          kind: "approval_pending",
          message: "Wallet policy approval is required",
          approvalRequestId: "approval_1",
          walletOperationId: "operation_1",
        },
      });

    render(
      <EarnVaultDepositModal strategy={strategy} onClose={vi.fn()} onDeposited={onDeposited} />
    );
    const user = await enterDepositAmount();
    expect((await screen.findByRole("alert")).textContent).toContain("Network unavailable");
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    expect(await screen.findByText("Approval required")).toBeTruthy();
    expect(screen.getByText("approval_1")).toBeTruthy();
    expect(screen.getByText("operation_1")).toBeTruthy();
    expect(onDeposited).not.toHaveBeenCalled();
    expect(mocks.createEarnVaultDeposit).toHaveBeenCalledTimes(2);

    const [firstInput, firstKey, firstSignal] = mocks.createEarnVaultDeposit.mock.calls[0];
    const [secondInput, secondKey, secondSignal] = mocks.createEarnVaultDeposit.mock.calls[1];
    const expectedInput = {
      strategyId: strategy.id,
      custodyWalletId: "wallet_1",
      amount: "1",
    };
    expect(firstInput).toEqual(expectedInput);
    expect(secondInput).toEqual(expectedInput);
    expect(firstInput).not.toHaveProperty("requestId");
    expect(firstKey).toBe(IDEMPOTENCY_KEY);
    expect(secondKey).toBe(firstKey);
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["pending", "Deposit pending"],
    ["submitted", "Deposit submitted"],
    ["confirmed", "Deposit confirmed"],
  ] as const)("renders a truthful %s result and refresh callback", async (status, title) => {
    const deposit = vaultDeposit(status);
    const onDeposited = vi.fn();
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", deposit },
    });

    render(
      <EarnVaultDepositModal strategy={strategy} onClose={vi.fn()} onDeposited={onDeposited} />
    );
    await enterDepositAmount();

    expect(await screen.findByText(title)).toBeTruthy();
    const transaction = screen.getByRole("link", { name: /5R3h9G/ });
    expect(transaction.getAttribute("href")).toBe(
      `https://explorer.solana.com/tx/${deposit.signature}?cluster=devnet`
    );
    expect(onDeposited).toHaveBeenCalledWith(deposit);
  });

  it("keeps a failed deposit on the form and reports the provider reason", async () => {
    const onDeposited = vi.fn();
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", deposit: vaultDeposit("failed") },
    });

    render(
      <EarnVaultDepositModal strategy={strategy} onClose={vi.fn()} onDeposited={onDeposited} />
    );
    await enterDepositAmount();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Provider simulation rejected the transaction"
    );
    expect(screen.getByRole("button", { name: "Confirm deposit" })).toBeTruthy();
    expect(onDeposited).not.toHaveBeenCalled();
  });

  it("does not present an unavailable balance as zero and blocks sub-atom input", async () => {
    mocks.useEarnFundingWallets.mockReturnValue({
      wallets: [fundingWallet(undefined)],
      error: undefined,
      isLoading: false,
    });
    const user = userEvent.setup();
    render(<EarnVaultDepositModal strategy={strategy} onClose={vi.fn()} />);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("radio", { name: /Treasury wallet/ }));
    expect(screen.getAllByText("Balance unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("Available: 0 USDC")).toBeNull();
    await user.type(screen.getByLabelText("Amount (USDC)"), "0.0000001");

    expect(screen.getByRole("alert").textContent).toContain("Use no more than 6 decimal places.");
    expect(
      (screen.getByRole("button", { name: "Confirm deposit" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(mocks.createEarnVaultDeposit).not.toHaveBeenCalled();
  });

  it("does not allow a wallet the API marks unavailable for runtime execution", async () => {
    const unavailableWallet = fundingWallet([]);
    unavailableWallet.isRuntimeExecutionAllowed = false;
    mocks.useEarnFundingWallets.mockReturnValue({
      wallets: [unavailableWallet],
      error: undefined,
      isLoading: false,
    });

    render(<EarnVaultDepositModal strategy={strategy} onClose={vi.fn()} />);

    const walletOption = await screen.findByRole("radio", { name: /Treasury wallet/ });
    expect((walletOption as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Signing unavailable")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Confirm deposit" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
