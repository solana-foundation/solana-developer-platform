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
import {
  claimVaultDepositIdempotencyKey,
  vaultDepositRequestFingerprint,
} from "./earn-vault-deposit-tracking";
import {
  floorForTolerance,
  isSlippageExceededRefusal,
  parseSlippageToleranceBps,
} from "./earn-vault-slippage";

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "prj_test";

const mocks = vi.hoisted(() => ({
  createEarnVaultDeposit: vi.fn(),
  useEarnFundingWallets: vi.fn(),
  useEarnVaultDepositOutcome: vi.fn(),
  fetchEarnVaultDepositByRequestId: vi.fn(),
  fetchEarnVaultDepositPreview: vi.fn(),
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
  "DashboardEarn.deposit.vaultDoneBody": "Signed and sent to Solana.",
  "DashboardEarn.deposit.vaultDoneStatus": "Awaiting confirmation",
  "DashboardEarn.deposit.vaultSettlingNote":
    "Your vault position will refresh after the chain confirms it.",
  "DashboardEarn.deposit.vaultConfirmedTitle": "Deposit confirmed",
  "DashboardEarn.deposit.vaultConfirmedBody": "The deposit is confirmed on Solana.",
  "DashboardEarn.deposit.vaultConfirmedStatus": "Confirmed",
  "DashboardEarn.deposit.vaultConfirmedNote":
    "Your live vault position will refresh automatically.",
  "DashboardEarn.deposit.vaultTransaction": "Transaction",
  "DashboardEarn.deposit.vaultPendingTitle": "Deposit pending",
  "DashboardEarn.deposit.vaultPendingBody": "The transaction is waiting to be submitted.",
  "DashboardEarn.deposit.vaultPendingStatus": "Status unknown",
  "DashboardEarn.deposit.vaultApprovalTitle": "Approval required",
  "DashboardEarn.deposit.vaultApprovalBody":
    "This deposit has not moved funds. It will execute only after wallet-policy approval.",
  "DashboardEarn.deposit.vaultApprovalRequest": "Approval request",
  "DashboardEarn.deposit.vaultAbsorbedTitle": "Deposit already completed by your approval",
  "DashboardEarn.deposit.vaultAbsorbedBody":
    "Your earlier approval for this exact deposit executed just before this submission, so the request was absorbed as a retry of it. Funds moved once, through the approval — this submission moved nothing additional.",
  "DashboardEarn.deposit.vaultAbsorbedStatus": "Handled by approval",
  "DashboardEarn.deposit.vaultAbsorbedNote":
    "The details below are the approved deposit. If you intended a second deposit of the same amount, submit again.",
  "DashboardEarn.deposit.vaultHeldKeyUnavailable":
    "SDP could not check whether your earlier approved deposit already went through, so nothing was submitted. Try again in a moment.",
  "DashboardEarn.deposit.vaultMinShares": "Minimum shares received",
  "DashboardEarn.deposit.vaultExpectedShares": "Expected shares",
  "DashboardEarn.deposit.vaultQuoteLoading": "Fetching the live share quote…",
  "DashboardEarn.deposit.vaultQuoteUnavailable":
    "The live share quote is unavailable right now, so this deposit cannot be sized safely. Try again in a moment.",
  "DashboardEarn.deposit.vaultQuoteBlocked":
    "The vault is not accepting this deposit right now: {message}",
  "DashboardEarn.deposit.vaultSlippageToggle": "Slippage tolerance: {percent}",
  "DashboardEarn.deposit.vaultSlippageLabel": "Slippage tolerance (basis points)",
  "DashboardEarn.deposit.vaultSlippageHelp":
    "The deposit refuses to execute if the vault would mint fewer shares than this tolerance allows.",
  "DashboardEarn.deposit.vaultSlippageInvalid":
    "Enter a whole number of basis points from 1 to {max}.",
  "DashboardEarn.deposit.vaultSlippageExceeded":
    "The vault would return fewer shares than your slippage tolerance allows for this amount. Increase the tolerance below and try again.",
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
  useEarnVaultDepositOutcome: mocks.useEarnVaultDepositOutcome,
  fetchEarnVaultDepositByRequestId: mocks.fetchEarnVaultDepositByRequestId,
  fetchEarnVaultDepositPreview: mocks.fetchEarnVaultDepositPreview,
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
  mocks.fetchEarnVaultDepositByRequestId.mockReset();
  mocks.fetchEarnVaultDepositPreview.mockReset();
  // Kamino declares no floor policy, so most tests never quote; the veda
  // suites override this with a real quote.
  mocks.fetchEarnVaultDepositPreview.mockResolvedValue({ kind: "unavailable" });
  // Default: nothing recorded under the key yet, so a held key stays held.
  mocks.fetchEarnVaultDepositByRequestId.mockResolvedValue({ kind: "absent" });
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
  // The store is what carries a key between submits now, so it has to start
  // empty; and each mint returns a DISTINCT value, otherwise "the retry reused
  // the key" would pass against a constant mock that proves nothing.
  sessionStorage.clear();
  let minted = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    minted += 1;
    return (
      minted === 1 ? IDEMPOTENCY_KEY : `22222222-2222-4222-8222-22222222222${minted}`
    ) as ReturnType<typeof crypto.randomUUID>;
  });
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
      <EarnVaultDepositModal
        projectId={PROJECT_ID}
        strategy={strategy}
        onClose={vi.fn()}
        onDeposited={onDeposited}
      />
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
    // No abort signal, DELIBERATELY: the POST moves value, so it must run to
    // completion and reach the key bookkeeping even if the modal unmounts.
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
    expect(firstSignal).toBeUndefined();
    expect(secondSignal).toBeUndefined();
  });

  it("carries the key across a remount, so a reload cannot cause a second deposit", async () => {
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: false,
      error: "Gateway timeout",
      status: 504,
      body: null,
    });

    const first = render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />
    );
    await enterDepositAmount();
    await screen.findByRole("alert");
    // Everything this component remembered is gone — the reload case.
    first.unmount();

    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await enterDepositAmount();
    await screen.findByRole("alert");

    expect(mocks.createEarnVaultDeposit).toHaveBeenCalledTimes(2);
    expect(mocks.createEarnVaultDeposit.mock.calls[1][1]).toBe(
      mocks.createEarnVaultDeposit.mock.calls[0][1]
    );
  });

  it("retires the key on a 4xx and keeps it on anything that might have written", async () => {
    // A 4xx refused the request on its own terms, so the next attempt is a new
    // request and must not replay. A 5xx may be a gateway timing out
    // downstream of an API that already recorded and broadcast the deposit.
    for (const [status, expectReuse] of [
      [422, false],
      [500, true],
    ] as const) {
      cleanup();
      sessionStorage.clear();
      mocks.createEarnVaultDeposit.mockReset();
      mocks.createEarnVaultDeposit.mockResolvedValue({
        ok: false,
        error: `Failed (${status})`,
        status,
        body: null,
      });

      render(
        <EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />
      );
      const user = await enterDepositAmount();
      await screen.findByRole("alert");
      await user.click(screen.getByRole("button", { name: "Confirm deposit" }));
      await vi.waitFor(() => expect(mocks.createEarnVaultDeposit).toHaveBeenCalledTimes(2));

      const [, firstKey] = mocks.createEarnVaultDeposit.mock.calls[0];
      const [, secondKey] = mocks.createEarnVaultDeposit.mock.calls[1];
      expect(secondKey === firstKey).toBe(expectReuse);
    }
  });

  it("keeps the key while an approval hold is still keyed by it", async () => {
    // Re-submitting under a fresh key would open a SECOND approval request for
    // the same intent, and no movement row exists yet to tell them apart.
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 202,
      data: { kind: "approval_pending", message: "Approval required" },
    });

    const held = render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />
    );
    await enterDepositAmount();
    await screen.findByText("Approval required");
    held.unmount();

    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await enterDepositAmount();
    await screen.findByText("Approval required");

    expect(mocks.createEarnVaultDeposit.mock.calls[1][1]).toBe(
      mocks.createEarnVaultDeposit.mock.calls[0][1]
    );
  });

  it("pins an approval hold even when the modal unmounts mid-flight", async () => {
    // The server records the 202 hold whether or not this component survives
    // the round trip. If unmount skipped the bookkeeping, the key would stay on
    // the 15-minute TTL while the approval lives for hours — and the eventual
    // resubmit would mint a fresh key, a SECOND approval request for one
    // intent.
    let respond: (value: unknown) => void = () => {};
    mocks.createEarnVaultDeposit.mockReturnValue(
      new Promise((resolve) => {
        respond = resolve;
      })
    );

    const view = render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />
    );
    await enterDepositAmount();
    await vi.waitFor(() => expect(mocks.createEarnVaultDeposit).toHaveBeenCalledTimes(1));

    // Browser Back / project switch: the component is gone before the answer.
    view.unmount();
    respond({
      ok: true,
      status: 202,
      data: { kind: "approval_pending", message: "Approval required" },
    });
    // Let the in-flight submit continuation run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The hold reached the store: two hours later — far past the default TTL —
    // the same fingerprint still claims the SAME key.
    const fingerprint = vaultDepositRequestFingerprint({
      projectId: PROJECT_ID,
      strategyId: strategy.id,
      custodyWalletId: "wallet_1",
      amount: "1",
      toleranceBps: null,
    });
    const entries = JSON.parse(
      sessionStorage.getItem("sdp:earn:vault-deposit:idempotency:v1") ?? "[]"
    ) as Array<{ id: string; createdAt: number; expiresAt?: number | null }>;
    const held = entries.find((entry) => entry.id === fingerprint);
    expect(held?.expiresAt).toBeNull();
    expect(claimVaultDepositIdempotencyKey(fingerprint)).toBe(
      mocks.createEarnVaultDeposit.mock.calls[0][1]
    );
  });

  it("announces the approval's win when it races the held-key check, instead of claiming this submission deposited", async () => {
    // TOCTOU: the pre-flight and the POST are two operations. The approval can
    // execute BETWEEN them — the lookup honestly says "absent", then the POST
    // finds the approval's movement under the key and answers replayed:true.
    // No client read can close that window; only the response can, and it must
    // be announced as the approval's execution — not as this submission
    // succeeding, and never as an auto-retry with a fresh key.
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 202,
      data: { kind: "approval_pending", message: "Approval required" },
    });
    const held = render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />
    );
    await enterDepositAmount();
    await screen.findByText("Approval required");
    held.unmount();

    // Check time: not yet executed. POST time: the approval just landed.
    mocks.fetchEarnVaultDepositByRequestId.mockResolvedValue({ kind: "absent" });
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "submitted", deposit: { ...vaultDeposit("submitted"), replayed: true } },
    });
    const onDeposited = vi.fn();
    render(
      <EarnVaultDepositModal
        projectId={PROJECT_ID}
        strategy={strategy}
        onClose={vi.fn()}
        onDeposited={onDeposited}
      />
    );
    await enterDepositAmount();

    // The truthful headline, not the success screen.
    expect(await screen.findByText("Deposit already completed by your approval")).toBeTruthy();
    expect(screen.queryByText("Deposit submitted")).toBeNull();
    // The SAME held key was knowingly reused — no fresh key, no second approval.
    expect(mocks.createEarnVaultDeposit.mock.calls[1][1]).toBe(
      mocks.createEarnVaultDeposit.mock.calls[0][1]
    );
    // The movement is real and may still be settling: refresh and watch it.
    expect(onDeposited).toHaveBeenCalledWith(
      expect.objectContaining({ movementId: "movement_1", replayed: true })
    );
    // Recorded deposit retires the key, so a deliberate second deposit mints
    // fresh and genuinely moves money.
    const fingerprint = vaultDepositRequestFingerprint({
      projectId: PROJECT_ID,
      strategyId: strategy.id,
      custodyWalletId: "wallet_1",
      amount: "1",
      toleranceBps: null,
    });
    expect(claimVaultDepositIdempotencyKey(fingerprint)).not.toBe(
      mocks.createEarnVaultDeposit.mock.calls[1][1]
    );
  });

  it("keeps the plain success screen for an ordinary same-session retry replay", async () => {
    // replayed:true WITHOUT a held key is the classic own-retry case — the
    // absorbed copy must not fire there.
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "submitted", deposit: { ...vaultDeposit("submitted"), replayed: true } },
    });
    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await enterDepositAmount();

    expect(await screen.findByText("Deposit submitted")).toBeTruthy();
    expect(screen.queryByText("Deposit already completed by your approval")).toBeNull();
  });

  it("retires a held key once its approval has actually executed", async () => {
    // The hold has no expiry, so it is the one key that can outlive what it
    // protected. Once the approval executed, a movement exists under it and
    // reusing it would replay that deposit and silently drop this one.
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 202,
      data: { kind: "approval_pending", message: "Approval required" },
    });

    const held = render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />
    );
    await enterDepositAmount();
    await screen.findByText("Approval required");
    held.unmount();

    // The approval was granted and executed while the modal was closed.
    mocks.fetchEarnVaultDepositByRequestId.mockResolvedValue({
      kind: "found",
      deposit: vaultDeposit("confirmed"),
    });

    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await enterDepositAmount();
    await screen.findByText("Approval required");

    expect(mocks.fetchEarnVaultDepositByRequestId).toHaveBeenCalledWith(
      mocks.createEarnVaultDeposit.mock.calls[0][1]
    );
    expect(mocks.createEarnVaultDeposit.mock.calls[1][1]).not.toBe(
      mocks.createEarnVaultDeposit.mock.calls[0][1]
    );
  });

  it("refuses to submit when it cannot tell whether a held key is spent", async () => {
    // Both guesses are wrong in a different direction — reusing a possibly-spent
    // key moves no money when the customer asked it to, minting a fresh one
    // opens a second approval — so neither belongs in a coin flip over funds.
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 202,
      data: { kind: "approval_pending", message: "Approval required" },
    });

    const held = render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />
    );
    await enterDepositAmount();
    await screen.findByText("Approval required");
    held.unmount();

    mocks.fetchEarnVaultDepositByRequestId.mockResolvedValue({ kind: "unavailable" });
    mocks.createEarnVaultDeposit.mockClear();

    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await enterDepositAmount();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "SDP could not check whether your earlier approved deposit already went through"
    );
    // The point: nothing was sent under either key.
    expect(mocks.createEarnVaultDeposit).not.toHaveBeenCalled();
  });

  it("does not consult the server for a key no approval is holding", async () => {
    // The check costs a request, so it is scoped to the only key that cannot
    // age out on its own.
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: false,
      error: "Gateway timeout",
      status: 504,
      body: null,
    });

    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    const user = await enterDepositAmount();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));
    await vi.waitFor(() => expect(mocks.createEarnVaultDeposit).toHaveBeenCalledTimes(2));

    expect(mocks.fetchEarnVaultDepositByRequestId).not.toHaveBeenCalled();
    // Still the ambiguous-retry rule: a 5xx keeps the key.
    expect(mocks.createEarnVaultDeposit.mock.calls[1][1]).toBe(
      mocks.createEarnVaultDeposit.mock.calls[0][1]
    );
  });

  it("retires the key once a deposit is recorded, so the next one is not a replay", async () => {
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", deposit: vaultDeposit("submitted") },
    });

    const done = render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />
    );
    await enterDepositAmount();
    await screen.findByText("Deposit submitted");
    done.unmount();

    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await enterDepositAmount();
    await screen.findByText("Deposit submitted");

    expect(mocks.createEarnVaultDeposit.mock.calls[1][1]).not.toBe(
      mocks.createEarnVaultDeposit.mock.calls[0][1]
    );
  });

  it.each([
    ["pending", "Deposit pending", "Status unknown"],
    ["submitted", "Deposit submitted", "Awaiting confirmation"],
    ["confirmed", "Deposit confirmed", "Confirmed"],
  ] as const)(
    "renders a truthful %s result and refresh callback",
    async (status, title, statusLabel) => {
      const deposit = vaultDeposit(status);
      const onDeposited = vi.fn();
      mocks.createEarnVaultDeposit.mockResolvedValue({
        ok: true,
        status: 201,
        data: { kind: "submitted", deposit },
      });

      render(
        <EarnVaultDepositModal
          projectId={PROJECT_ID}
          strategy={strategy}
          onClose={vi.fn()}
          onDeposited={onDeposited}
        />
      );
      await enterDepositAmount();

      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText(statusLabel)).toBeTruthy();
      const transaction = screen.getByRole("link", { name: /5R3h9G/ });
      expect(transaction.getAttribute("href")).toBe(
        `https://explorer.solana.com/tx/${deposit.signature}?cluster=devnet`
      );
      expect(onDeposited).toHaveBeenCalledWith(deposit);
    }
  );

  it("keeps a failed deposit on the form and reports the provider reason", async () => {
    const onDeposited = vi.fn();
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", deposit: vaultDeposit("failed") },
    });

    render(
      <EarnVaultDepositModal
        projectId={PROJECT_ID}
        strategy={strategy}
        onClose={vi.fn()}
        onDeposited={onDeposited}
      />
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
    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
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

  it("funds a deposit in another stablecoin: source balance, swap fields, distinct key", async () => {
    const USDG_MINT = "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7";
    mocks.useEarnFundingWallets.mockReturnValue({
      wallets: [
        fundingWallet([
          { token: "USDC", mint: USDC_MINT, amount: "2500000", uiAmount: "2.5", decimals: 6 },
          { token: "USDG", mint: USDG_MINT, amount: "7000000", uiAmount: "7", decimals: 6 },
        ]),
      ],
      error: undefined,
      isLoading: false,
    });
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", deposit: vaultDeposit("submitted") },
    });
    const user = userEvent.setup();
    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("radio", { name: /Treasury wallet/ }));
    await user.click(screen.getByRole("radio", { name: "USDG" }));

    // The whole form speaks the FUNDING token now: label and balance.
    expect(screen.getAllByText("Available: 7 USDG").length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("Amount (USDG)"), "5");
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    expect(mocks.createEarnVaultDeposit).toHaveBeenCalledWith(
      {
        strategyId: strategy.id,
        custodyWalletId: "wallet_1",
        amount: "5",
        sourceTokenMint: USDG_MINT,
        swapSlippageBps: 2,
      },
      IDEMPOTENCY_KEY
    );
    // Paying in a different token is a DIFFERENT request: the held-key
    // fingerprint must not collide with an unswapped deposit of the same
    // amount, or a retry of one would replay the other.
    expect(
      vaultDepositRequestFingerprint({
        projectId: PROJECT_ID,
        strategyId: strategy.id,
        custodyWalletId: "wallet_1",
        amount: "5",
        toleranceBps: null,
        sourceTokenMint: USDG_MINT,
      })
    ).not.toBe(
      vaultDepositRequestFingerprint({
        projectId: PROJECT_ID,
        strategyId: strategy.id,
        custodyWalletId: "wallet_1",
        amount: "5",
        toleranceBps: null,
      })
    );
  });

  it("sends no swap fields when the customer pays in the vault's own token", async () => {
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", deposit: vaultDeposit("submitted") },
    });
    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await enterDepositAmount("1.000000");

    expect(mocks.createEarnVaultDeposit).toHaveBeenCalledWith(
      { strategyId: strategy.id, custodyWalletId: "wallet_1", amount: "1" },
      IDEMPOTENCY_KEY
    );
  });

  it("does not allow a wallet the API marks unavailable for runtime execution", async () => {
    const unavailableWallet = fundingWallet([]);
    unavailableWallet.isRuntimeExecutionAllowed = false;
    mocks.useEarnFundingWallets.mockReturnValue({
      wallets: [unavailableWallet],
      error: undefined,
      isLoading: false,
    });

    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);

    const walletOption = await screen.findByRole("radio", { name: /Treasury wallet/ });
    expect((walletOption as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Signing unavailable")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Confirm deposit" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});

describe("slippage tolerance helpers", () => {
  it("accepts whole basis points from 1 to 1000 and nothing else", () => {
    expect(parseSlippageToleranceBps("10")).toBe(10);
    expect(parseSlippageToleranceBps(" 1 ")).toBe(1);
    expect(parseSlippageToleranceBps("1000")).toBe(1000);
    for (const value of ["0", "1001", "-1", "1.5", "", "ten", "10bps"]) {
      expect(parseSlippageToleranceBps(value)).toBeNull();
    }
  });

  it("derives the floor at mint scale without a number round trip", () => {
    expect(floorForTolerance("20", 6, 10)).toBe("19.98");
    expect(floorForTolerance("1", 6, 10)).toBe("0.999");
    // Rounds DOWN to the atom — never up past what the vault would quote.
    expect(floorForTolerance("0.000003", 6, 10)).toBe("0.000002");
    // Dust clamps to one atom rather than a zero floor the builder refuses.
    expect(floorForTolerance("0.000001", 6, 10)).toBe("0.000001");
    // Exact above 2^53 atoms.
    expect(floorForTolerance("10000000000000000", 6, 100)).toBe("9900000000000000");
    // A ZERO quote has no satisfiable floor: one atom would demand MORE than
    // the vault expects to return. `null` tells the caller to block, not clamp.
    expect(floorForTolerance("0", 6, 10)).toBeNull();
  });

  it("recognizes the API's slippage refusal envelope and nothing else", () => {
    expect(isSlippageExceededRefusal({ error: { details: { reason: "slippage_exceeded" } } })).toBe(
      true
    );
    for (const body of [
      null,
      "error",
      {},
      { error: null },
      { error: { details: null } },
      { error: { details: { reason: "other" } } },
    ]) {
      expect(isSlippageExceededRefusal(body)).toBe(false);
    }
  });
});

describe("slippage-floored providers", () => {
  const vedaStrategy: EarnStrategy = { ...strategy, provider: "veda" };

  function primeQuote(sharesOut: string, blockingIssues: { code: string; message: string }[] = []) {
    mocks.fetchEarnVaultDepositPreview.mockResolvedValue({
      kind: "quoted",
      preview: { strategyId: vedaStrategy.id, sharesOut, shareDecimals: 6, blockingIssues },
    });
  }

  async function enterVedaDepositAmount(amount = "1.000000") {
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "Deposit into Institutional USDC Vault" });
    await user.click(screen.getByRole("radio", { name: /Treasury wallet/ }));
    await user.type(screen.getByLabelText("Amount (USDC)"), amount);
    // The floor waits on the debounced live quote; the summary row appearing is
    // the signal that confirm is armed with a quote-derived floor.
    await screen.findByText("Minimum shares received", undefined, { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));
    return user;
  }

  it("derives the floor from the LIVE quote, not the amount", async () => {
    // A rate the amount-arithmetic would get wrong: 1 USDC quotes 0.99999
    // shares, so a 10 bps floor is 0.99899 — not the 0.999 the amount implies.
    primeQuote("0.99999");
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "submitted", deposit: vaultDeposit("submitted") },
    });
    render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={vedaStrategy} onClose={vi.fn()} />
    );
    await enterVedaDepositAmount("1.000000");
    await screen.findByText("Deposit submitted");
    expect(mocks.fetchEarnVaultDepositPreview).toHaveBeenCalledWith(
      { strategyId: vedaStrategy.id, amount: "1" },
      expect.anything()
    );
    expect(mocks.createEarnVaultDeposit.mock.calls[0][0]).toEqual({
      strategyId: strategy.id,
      custodyWalletId: "wallet_1",
      amount: "1",
      minSharesOut: "0.99899",
    });
  });

  it("sends no derived floor and never quotes for a provider with no declared policy", async () => {
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "submitted", deposit: vaultDeposit("submitted") },
    });
    render(<EarnVaultDepositModal projectId={PROJECT_ID} strategy={strategy} onClose={vi.fn()} />);
    await enterDepositAmount();
    await screen.findByText("Deposit submitted");
    expect(mocks.fetchEarnVaultDepositPreview).not.toHaveBeenCalled();
    expect(mocks.createEarnVaultDeposit.mock.calls[0][0]).toEqual({
      strategyId: strategy.id,
      custodyWalletId: "wallet_1",
      amount: "1",
    });
    // No policy, no control: the disclosure never renders for this provider.
    expect(screen.queryByText(/Slippage tolerance:/)).toBeNull();
  });

  it("disables the deposit while the quote is unavailable, never guessing a floor", async () => {
    mocks.fetchEarnVaultDepositPreview.mockResolvedValue({ kind: "unavailable" });
    render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={vedaStrategy} onClose={vi.fn()} />
    );
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "Deposit into Institutional USDC Vault" });
    await user.click(screen.getByRole("radio", { name: /Treasury wallet/ }));
    await user.type(screen.getByLabelText("Amount (USDC)"), "1");

    expect(
      await screen.findByText(/live share quote is unavailable/, undefined, { timeout: 3000 })
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Confirm deposit" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(mocks.createEarnVaultDeposit).not.toHaveBeenCalled();
  });

  it("surfaces a vault-reported blocking issue in its own words and refuses to arm", async () => {
    primeQuote("1", [{ code: "TELLER_PAUSED", message: "The teller is paused." }]);
    render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={vedaStrategy} onClose={vi.fn()} />
    );
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "Deposit into Institutional USDC Vault" });
    await user.click(screen.getByRole("radio", { name: /Treasury wallet/ }));
    await user.type(screen.getByLabelText("Amount (USDC)"), "1");

    expect(
      await screen.findByText(/The teller is paused/, undefined, { timeout: 3000 })
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Confirm deposit" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("answers a blown floor with its own copy, opens the control, and re-quotes", async () => {
    primeQuote("1");
    mocks.createEarnVaultDeposit.mockResolvedValue({
      ok: false,
      status: 400,
      error:
        "Vault deposit simulation failed: the vault would return less than the request's slippage floor allows.",
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Vault deposit simulation failed",
          details: { reason: "slippage_exceeded" },
        },
      },
    });
    render(
      <EarnVaultDepositModal projectId={PROJECT_ID} strategy={vedaStrategy} onClose={vi.fn()} />
    );
    await enterVedaDepositAmount("1.000000");

    // This surface's own words, not the relayed simulation log…
    expect(await screen.findByText(/Increase the tolerance below/)).toBeTruthy();
    expect(screen.queryByText(/simulation failed/)).toBeNull();
    // …the control that fixes it is open, prefilled with the default…
    const toleranceInput = screen.getByLabelText(
      "Slippage tolerance (basis points)"
    ) as HTMLInputElement;
    expect(toleranceInput.value).toBe("10");
    // …and the retry's floor will come from a FRESH quote, not the refused one.
    await vi.waitFor(() => {
      expect(mocks.fetchEarnVaultDepositPreview.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
