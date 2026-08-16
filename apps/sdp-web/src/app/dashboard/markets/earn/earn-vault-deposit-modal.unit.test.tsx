// @vitest-environment jsdom

import type { CustodyWalletSummary, EarnStrategy } from "@sdp/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => ({
  createDeposit: vi.fn(),
  wallet: {
    id: "cwlt_exact_row",
    custodyConfigId: "custody_config_one",
    walletId: "provider_wallet_not_globally_unique",
    publicKey: "7M6bFdwsXQZX9MjoD4PDxQJb9FZbwdQh6VS8sK7F3WcQ",
    label: "Treasury Ops",
    purpose: null,
    status: "active",
    createdAt: "2026-08-15T00:00:00.000Z",
    provider: "fireblocks",
    isRuntimeExecutionAllowed: true,
    balances: [
      {
        token: "USDC",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "9000000000",
        uiAmount: "9000",
        decimals: 6,
      },
      {
        token: "USDT",
        mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        amount: "12500000",
        uiAmount: "12.5",
        decimals: 6,
      },
    ],
  } satisfies CustodyWalletSummary,
}));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key,
  useLocale: () => "en",
}));

vi.mock("./deposit/earn-funding-wallets", async (importOriginal) => {
  const original = await importOriginal<typeof import("./deposit/earn-funding-wallets")>();
  return {
    ...original,
    useEarnFundingWallets: () => ({ wallets: [data.wallet], error: undefined, isLoading: false }),
  };
});

vi.mock("./earn-program-data", async (importOriginal) => {
  const original = await importOriginal<typeof import("./earn-program-data")>();
  return { ...original, createEarnVaultDeposit: data.createDeposit };
});

import { EarnVaultDepositModal } from "./earn-vault-deposit-modal";

const USDT_STRATEGY: EarnStrategy = {
  id: "kamino-usdt-vault",
  provider: "kamino",
  providerReference: "vault-usdt",
  name: "Kamino USDT Vault",
  sourceKind: "defi",
  depositMints: ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"],
  apyType: "variable",
  currentApy: "0.05",
  liquidityTerm: "instant",
  status: "active",
  hostCluster: "mainnet-beta",
  fundable: true,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  data.createDeposit.mockReset();
});

describe("EarnVaultDepositModal", () => {
  it("quotes the strategy token and submits the exact SDP custody row", async () => {
    data.createDeposit.mockResolvedValue({ ok: false, error: "Expected test refusal" });
    const user = userEvent.setup();
    render(<EarnVaultDepositModal onClose={() => {}} strategy={USDT_STRATEGY} />);

    await user.click(await screen.findByRole("radio"));
    await user.click(screen.getByRole("button", { name: "DashboardEarn.deposit.continueAction" }));

    const amount = await screen.findByLabelText("DashboardEarn.deposit.vaultAmount(USDT)");
    expect(
      screen.getByText("DashboardEarn.deposit.vaultBalanceAvailable(12.5 USDT)")
    ).not.toBeNull();
    expect(screen.queryByText(/9,000 USDC/)).toBeNull();

    await user.type(amount, "2");
    await user.click(screen.getByRole("button", { name: "DashboardEarn.deposit.vaultSubmit" }));

    await waitFor(() => expect(data.createDeposit).toHaveBeenCalledOnce());
    expect(data.createDeposit).toHaveBeenCalledWith({
      strategyId: USDT_STRATEGY.id,
      custodyWalletId: data.wallet.id,
      amount: "2",
      requestId: expect.any(String),
    });
  });
});
