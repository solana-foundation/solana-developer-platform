// @vitest-environment jsdom

import type { EarnVaultPosition, EarnVaultWithdrawal } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetIdempotencyKeyStoresForTests } from "./earn-idempotency-key-store";
import { EarnVaultWithdrawModal } from "./earn-vault-withdraw-modal";

const mocks = vi.hoisted(() => ({
  createEarnVaultWithdrawal: vi.fn(),
  fetchEarnVaultWithdrawalsByRequestId: vi.fn(),
  fetchEarnVaultWithdrawalPreview: vi.fn(),
  useEarnVaultWithdrawalOutcomeToast: vi.fn(),
}));

vi.mock("./earn-program-data", () => ({
  createEarnVaultWithdrawal: mocks.createEarnVaultWithdrawal,
  fetchEarnVaultWithdrawalsByRequestId: mocks.fetchEarnVaultWithdrawalsByRequestId,
  fetchEarnVaultWithdrawalPreview: mocks.fetchEarnVaultWithdrawalPreview,
  useEarnVaultWithdrawalOutcomeToast: mocks.useEarnVaultWithdrawalOutcomeToast,
}));

const position: EarnVaultPosition = {
  id: "earn_position_1",
  provider: "kamino",
  providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  label: "Kamino USDC Vault",
  custodyWalletId: "cwlt_1",
  tokenMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  shareMint: "So11111111111111111111111111111111111111112",
  createdAt: "2026-08-21T00:00:00.000Z",
  closedAt: null,
  shares: "10",
  withdrawableShares: "6",
  tokenValue: "10.5",
};

function withdrawal(status: EarnVaultWithdrawal["status"]): EarnVaultWithdrawal {
  return {
    movementId: "earn_movement_1",
    positionId: position.id,
    provider: position.provider,
    providerReference: position.providerReference,
    status,
    signature: "sig_recorded_not_broadcast",
    shares: "6",
    shareMint: position.shareMint,
    failureReason: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    confirmedAt: null,
    settledAt: null,
  };
}

function renderModal(onWithdrawn = vi.fn(), modalPosition: EarnVaultPosition = position) {
  return {
    onWithdrawn,
    ...render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <EarnVaultWithdrawModal
          environment="sandbox"
          onClose={vi.fn()}
          onWithdrawn={onWithdrawn}
          position={modalPosition}
          projectId="prj_1"
        />
      </I18nProvider>
    ),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  vi.clearAllMocks();
  mocks.fetchEarnVaultWithdrawalsByRequestId.mockResolvedValue({ kind: "absent" });
  // Kamino declares no exit floor policy, so most tests never quote; the veda
  // suite overrides this with a real quote.
  mocks.fetchEarnVaultWithdrawalPreview.mockResolvedValue({ kind: "unavailable" });
});

afterEach(cleanup);

describe("EarnVaultWithdrawModal", () => {
  it("caps Max at unstaked withdrawable shares", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("button", { name: "Max" }));

    expect((screen.getByLabelText("Shares to redeem") as HTMLInputElement).value).toBe("6");
    expect(screen.getByText(/6 shares available to withdraw of 10 total/)).toBeTruthy();
  });

  it("disables Max when the withdrawable balance is unavailable", () => {
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <EarnVaultWithdrawModal
          environment="sandbox"
          onClose={vi.fn()}
          onWithdrawn={vi.fn()}
          position={{ ...position, withdrawableShares: undefined }}
          projectId="prj_1"
        />
      </I18nProvider>
    );

    expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/withdrawable balance is unavailable/)).toBeTruthy();
  });

  it("renders a recorded response as queued without a premature explorer link", async () => {
    const user = userEvent.setup();
    const recorded = withdrawal("requested");
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "withdrawal", withdrawal: recorded },
    });
    const { onWithdrawn } = renderModal();

    await user.type(screen.getByLabelText("Shares to redeem"), "6");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Withdrawal queued")).toBeTruthy();
    expect(
      screen.getByText(/signed and recorded, but broadcast has not been confirmed/)
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(onWithdrawn).toHaveBeenCalledWith(recorded);
  });
});

describe("exit slippage floors (quote-derived)", () => {
  const vedaPosition: EarnVaultPosition = {
    ...position,
    provider: "veda",
    label: "Veda USDC vault #0",
  };

  function primeQuote(assetsOut: string, blockingIssues: { code: string; message: string }[] = []) {
    mocks.fetchEarnVaultWithdrawalPreview.mockResolvedValue({
      kind: "quoted",
      preview: { positionId: vedaPosition.id, assetsOut, assetDecimals: 6, blockingIssues },
    });
  }

  async function enterVedaShares(shares = "5") {
    const user = userEvent.setup();
    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Shares to redeem"), shares);
    // The floor waits on the debounced live quote; the summary row appearing is
    // the signal that confirm is armed with a quote-derived floor.
    await screen.findByText("Minimum amount received", undefined, { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    return user;
  }

  it("derives the exit floor from the LIVE quote and sends it with the withdrawal", async () => {
    primeQuote("4.997");
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "submitted", withdrawal: withdrawal("submitted") },
    });
    renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");

    await screen.findByText("Withdrawal submitted");
    expect(mocks.fetchEarnVaultWithdrawalPreview).toHaveBeenCalledWith(
      { positionId: vedaPosition.id, shares: "5" },
      expect.anything()
    );
    // 4.997 × (1 − 10 bps), floored to the token's six decimals.
    expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toEqual({
      positionId: vedaPosition.id,
      shares: "5",
      minAmountOut: "4.992003",
    });
  });

  it("disables the exit while the quote is unavailable, never guessing a floor", async () => {
    mocks.fetchEarnVaultWithdrawalPreview.mockResolvedValue({ kind: "unavailable" });
    renderModal(vi.fn(), vedaPosition);
    const user = userEvent.setup();
    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Shares to redeem"), "5");

    expect(
      await screen.findByText(/live payout quote is unavailable/, undefined, { timeout: 3000 })
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Confirm withdrawal" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(mocks.createEarnVaultWithdrawal).not.toHaveBeenCalled();
  });

  it("answers a blown floor with its own copy, opens the control, and re-quotes", async () => {
    primeQuote("4.997");
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: false,
      status: 400,
      error:
        "Vault withdrawal simulation failed: the vault would return less than the request's slippage floor allows.",
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Vault withdrawal simulation failed",
          details: { reason: "slippage_exceeded" },
        },
      },
    });
    renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");

    expect(await screen.findByText(/Increase the tolerance below and try again/)).toBeTruthy();
    const toleranceInput = screen.getByLabelText(
      "Slippage tolerance (basis points)"
    ) as HTMLInputElement;
    expect(toleranceInput.value).toBe("10");
    await vi.waitFor(() => {
      expect(mocks.fetchEarnVaultWithdrawalPreview.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("sends no floor and never quotes for a provider with no declared policy", async () => {
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "submitted", withdrawal: withdrawal("submitted") },
    });
    renderModal();
    const user = userEvent.setup();
    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Shares to redeem"), "5");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    await screen.findByText("Withdrawal submitted");
    expect(mocks.fetchEarnVaultWithdrawalPreview).not.toHaveBeenCalled();
    expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toEqual({
      positionId: position.id,
      shares: "5",
    });
    expect(screen.queryByText(/Slippage tolerance:/)).toBeNull();
  });
});
