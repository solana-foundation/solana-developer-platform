// @vitest-environment jsdom

import type { EarnVaultPosition, EarnVaultWithdrawal } from "@sdp/types/earn";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "@/app/(session)/dashboard/[projectId]/markets/test-i18n";
import { VAULT_QUOTE_DEBOUNCE_MS, VAULT_QUOTE_TTL_MS } from "./earn-vault-slippage";
import { EarnVaultWithdrawModal } from "./earn-vault-withdraw-modal";
import { resetVaultWithdrawalTrackingStateForTests } from "./earn-vault-withdraw-tracking";

const mocks = vi.hoisted(() => ({
  createEarnVaultWithdrawal: vi.fn(),
  fetchEarnVaultWithdrawalPreview: vi.fn(),
  useEarnVaultWithdrawalOutcome: vi.fn(),
}));

vi.mock("./earn-program-data", () => ({
  createEarnVaultWithdrawal: mocks.createEarnVaultWithdrawal,
  fetchEarnVaultWithdrawalPreview: mocks.fetchEarnVaultWithdrawalPreview,
  useEarnVaultWithdrawalOutcome: mocks.useEarnVaultWithdrawalOutcome,
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
  feeSponsored: false,
  shares: "10",
  withdrawableShares: "6",
  tokenValue: "10",
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
    ownerAddress: null,
    failureReason: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    confirmedAt: null,
    settledAt: null,
  };
}

function renderModal(
  onWithdrawn = vi.fn(),
  modalPosition: EarnVaultPosition = position,
  settlement?: React.ComponentProps<typeof EarnVaultWithdrawModal>["settlement"]
) {
  return {
    onWithdrawn,
    ...render(
      <EnglishTestI18n>
        <EarnVaultWithdrawModal
          environment="sandbox"
          onClose={vi.fn()}
          onWithdrawn={onWithdrawn}
          position={modalPosition}
          projectId="prj_1"
          settlement={settlement}
        />
      </EnglishTestI18n>
    ),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  resetVaultWithdrawalTrackingStateForTests();
  vi.clearAllMocks();
  // Kamino declares no exit floor policy, so most tests never quote; the veda
  // suite overrides this with a real quote.
  mocks.fetchEarnVaultWithdrawalPreview.mockResolvedValue({ kind: "unavailable" });
});

afterEach(cleanup);

/** The flow's progress as the reader sees it: the current step's name and "Step x of y". */
function flowProgress(): { step: string | null; label: string | undefined } {
  const progress = document.querySelector("[data-earn-flow-step]");
  return {
    step: progress?.getAttribute("data-earn-flow-step") ?? null,
    label: progress?.querySelector('[role="status"]')?.textContent ?? undefined,
  };
}

describe("EarnVaultWithdrawModal", () => {
  it("caps Max at the dollar value of unstaked withdrawable shares", async () => {
    const user = userEvent.setup();
    renderModal();
    expect(flowProgress()).toEqual({ step: "Details", label: "Details, Step 1 of 4" });
    expect(screen.getByText("$")).toBeTruthy();

    const amountInput = screen.getByLabelText("Amount") as HTMLInputElement;
    const maxButton = screen.getByRole("button", { name: "Max" });
    expect(amountInput.parentElement?.contains(maxButton)).toBe(true);
    await user.click(maxButton);

    expect(amountInput.value).toBe("6");
    expect(screen.getByText(/\$6.00 available of \$10.00 total/)).toBeTruthy();
  });

  it("continues to the review on Enter, and never submits the withdrawal on Enter", async () => {
    const user = userEvent.setup();
    renderModal();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" }).getAttribute("disabled")).toBeNull()
    );
    await user.click(screen.getByLabelText("Amount"));
    await user.keyboard("{Enter}");
    expect(flowProgress()).toEqual({ step: "Review", label: "Review, Step 2 of 4" });

    await user.keyboard("{Enter}");
    expect(mocks.createEarnVaultWithdrawal).not.toHaveBeenCalled();
  });

  it("submits exact provider-order shares without inventing a dollar value", async () => {
    const user = userEvent.setup();
    const exactShares = "10.123456789";
    const submitted = {
      ...withdrawal("requested"),
      provider: "wisdomtree",
      shares: exactShares,
    };
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "withdrawal", withdrawal: submitted },
    });
    const { onWithdrawn } = renderModal(
      vi.fn(),
      {
        ...position,
        provider: "wisdomtree",
        label: "WisdomTree WTGXX",
        shares: exactShares,
        withdrawableShares: exactShares,
        tokenValue: undefined,
      },
      "provider_order"
    );

    const sharesInput = screen.getByLabelText("Shares") as HTMLInputElement;
    expect(screen.queryByText("$")).toBeNull();
    expect(screen.getByText(`${exactShares} withdrawable`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Max" }));
    expect(sharesInput.value).toBe(exactShares);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(exactShares)).toBeTruthy();
    expect(screen.queryByText("Expected proceeds")).toBeNull();
    expect(screen.queryByText("Minimum received")).toBeNull();
    expect(screen.queryByText("Receive")).toBeNull();
    expect(screen.getByText(/guarantees no cash amount/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledWith(
      { positionId: position.id, shares: exactShares },
      expect.any(String)
    );
    expect(mocks.fetchEarnVaultWithdrawalPreview).not.toHaveBeenCalled();
    expect(onWithdrawn).toHaveBeenCalledWith(submitted, {
      amount: exactShares,
      submittedAt: expect.any(Number),
    });
  });

  it("blocks provider-order shares above the live withdrawable balance", () => {
    renderModal(
      vi.fn(),
      {
        ...position,
        provider: "wisdomtree",
        label: "WisdomTree WTGXX",
        tokenValue: undefined,
      },
      "provider_order"
    );

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "6.000000001" } });

    expect(
      screen.getByText(/exceeds this position's last observed withdrawable share balance/)
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("reviews the withdrawal before confirmation and preserves the amount on back", async () => {
    const user = userEvent.setup();
    renderModal();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2.5" } });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("$2.50")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("2.5");
  });

  it("names SDP as the fee payer when the position says the exit is sponsored", async () => {
    // From the position, never the quote: Kamino declares no exit floor, so no
    // quote is fetched and a flag riding on it could never surface here.
    renderModal(vi.fn(), { ...position, feeSponsored: true });
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("SDP covers the network fee.")).toBeTruthy();
    expect(mocks.fetchEarnVaultWithdrawalPreview).not.toHaveBeenCalled();
  });

  it("keeps the wallet-pays note for an unsponsored exit", async () => {
    renderModal();
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("The custody wallet pays the network fee.")).toBeTruthy();
  });

  it("disables Max when the withdrawable balance is unavailable", () => {
    render(
      <EnglishTestI18n>
        <EarnVaultWithdrawModal
          environment="sandbox"
          onClose={vi.fn()}
          onWithdrawn={vi.fn()}
          position={{ ...position, withdrawableShares: undefined }}
          projectId="prj_1"
        />
      </EnglishTestI18n>
    );

    expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/current dollar value is unavailable/)).toBeTruthy();
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

    await user.type(screen.getByLabelText("Amount"), "6");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Withdrawal queued")).toBeTruthy();
    expect(screen.getByText(/Signed and recorded/)).toBeTruthy();
    expect(screen.getByText("Processing")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(document.querySelector(".earn-processing-modal")).toBeTruthy();
    expect(document.querySelector('[data-earn-processing="true"]')).toBeNull();
    expect(document.querySelector('[data-earn-step-processing="true"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(onWithdrawn).toHaveBeenCalledWith(recorded, {
      amount: "6",
      submittedAt: expect.any(Number),
    });
  });

  it("renders a confirmed withdrawal as complete while finalization continues", async () => {
    const confirmed = withdrawal("confirmed");
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "withdrawal", withdrawal: confirmed },
    });
    renderModal();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Withdrawal complete")).toBeTruthy();
    expect(screen.getByText(/confirmed on Solana and complete in the dashboard/)).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(document.querySelector(".earn-processing-modal")).toBeNull();
    expect(document.querySelector('[data-earn-outcome="success"]')).toBeTruthy();
    expect(flowProgress()).toEqual({ step: "Complete", label: "Complete, Step 4 of 4" });
  });

  it("badges a full exit Closed, not Active", async () => {
    const exited = { ...withdrawal("finalized"), shares: "10" };
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "withdrawal", withdrawal: exited },
    });
    renderModal(vi.fn(), { ...position, withdrawableShares: "10" });

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Withdrawal complete")).toBeTruthy();
    expect(screen.getByText("Closed")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    expect(document.querySelector('[data-earn-outcome="success"]')).toBeTruthy();
  });

  it("keeps a finalized provider order visibly pending its separate payout", async () => {
    const finalized = {
      ...withdrawal("finalized"),
      provider: "wisdomtree",
    };
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "withdrawal", withdrawal: finalized },
    });
    renderModal(
      vi.fn(),
      {
        ...position,
        provider: "wisdomtree",
        label: "WisdomTree WTGXX",
        tokenValue: undefined,
      },
      "provider_order"
    );

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/guarantees no cash amount/)).toBeTruthy();
    expect(screen.queryByText("$6.00")).toBeNull();
    expect(screen.queryByText("Expected proceeds")).toBeNull();
    expect(screen.queryByText("Minimum received")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Redemption order in progress")).toBeTruthy();
    expect(screen.getByText("Awaiting provider settlement")).toBeTruthy();
    expect(screen.getByText(/not proof of a provider payout/)).toBeTruthy();
    expect(screen.getByText(/neither delivers nor guarantees a cash amount/)).toBeTruthy();
    expect(screen.getByText("Provider settlement")).toBeTruthy();
    expect(flowProgress()).toEqual({
      step: "Provider settlement",
      label: "Provider settlement, Step 4 of 5",
    });
    expect(screen.queryByText(/proceeds are in the custody wallet/)).toBeNull();
    expect(screen.queryByText(/same transaction/i)).toBeNull();
  });

  it("keeps a confirmed provider order visibly pending unverified provider settlement", async () => {
    const confirmed = {
      ...withdrawal("confirmed"),
      provider: "wisdomtree",
    };
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "withdrawal", withdrawal: confirmed },
    });
    renderModal(
      vi.fn(),
      {
        ...position,
        provider: "wisdomtree",
        label: "WisdomTree WTGXX",
        tokenValue: undefined,
      },
      "provider_order"
    );

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Awaiting provider settlement")).toBeTruthy();
    expect(screen.getByText(/not proof of a provider payout/)).toBeTruthy();
    expect(screen.queryByText("Sending shares")).toBeNull();
    expect(screen.queryByText(/share transfer is final on Solana/)).toBeNull();
    expect(flowProgress().step).not.toBe("Complete");
  });

  it("renders an observed provider-order transfer failure as failed", async () => {
    const requested = {
      ...withdrawal("requested"),
      provider: "wisdomtree",
    };
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "withdrawal", withdrawal: requested },
    });
    mocks.useEarnVaultWithdrawalOutcome.mockReturnValue({
      ...requested,
      status: "failed",
      failureReason: "Transaction rejected",
    });
    renderModal(
      vi.fn(),
      {
        ...position,
        provider: "wisdomtree",
        label: "WisdomTree WTGXX",
        tokenValue: undefined,
      },
      "provider_order"
    );

    fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Redemption transfer failed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/No provider payout was recorded/)).toBeTruthy();
    expect(screen.queryByText("Awaiting provider settlement")).toBeNull();
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

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advancePastQuoteDebounce() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VAULT_QUOTE_DEBOUNCE_MS);
    });
  }

  async function armVedaShares(shares = "5") {
    screen.getByRole("dialog");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: shares } });
    await advancePastQuoteDebounce();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    // The floor waits on the debounced live quote; the summary row appearing is
    // the signal that confirm is armed with a quote-derived floor.
    expect(screen.getByText("Minimum received")).toBeTruthy();
  }

  async function enterVedaShares(shares = "5") {
    await armVedaShares(shares);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
  }

  /** Flush the submit's promise chain without moving any timer. */
  async function flushSubmission() {
    await act(async () => {
      for (let step = 0; step < 25; step += 1) await Promise.resolve();
    });
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
    screen.getByRole("dialog");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    await advancePastQuoteDebounce();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getByText(/live payout quote is unavailable/)).toBeTruthy();
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

  it("replays a kept key's exit floor verbatim after an ambiguous failure", async () => {
    mocks.fetchEarnVaultWithdrawalPreview
      .mockResolvedValueOnce({
        kind: "quoted",
        preview: {
          positionId: vedaPosition.id,
          assetsOut: "4.997",
          assetDecimals: 6,
          blockingIssues: [],
        },
      })
      .mockResolvedValue({
        kind: "quoted",
        preview: {
          positionId: vedaPosition.id,
          assetsOut: "2.5",
          assetDecimals: 6,
          blockingIssues: [],
        },
      });
    // A 5xx is the ambiguous case: the API may have recorded and broadcast the
    // exit, and the key stays live in the store either way.
    mocks.createEarnVaultWithdrawal
      .mockResolvedValueOnce({
        ok: false,
        error: "Bad gateway",
        status: 503,
        body: null,
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });

    const first = renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");
    await vi.waitFor(() => expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1));
    first.unmount();

    // enterVedaShares hands back real timers before its confirm click; the
    // second arm needs the fake clock again for the debounced quote.
    vi.useFakeTimers();
    renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");

    // The retry is the SAME request under the SAME key, so it must carry the
    // floor that key was MINTED with — not a fresh floor off the moved rate.
    // A re-derived floor would conflict with the API's recorded fingerprint
    // (a 409), retire the key, and let the next submit exit a second time
    // while the first attempt may already have executed.
    expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(2);
    expect(mocks.createEarnVaultWithdrawal.mock.calls[1][0]).toMatchObject({
      minAmountOut: "4.992003",
    });
    expect(mocks.createEarnVaultWithdrawal.mock.calls[1][1]).toBe(
      mocks.createEarnVaultWithdrawal.mock.calls[0][1]
    );
  });

  it("stops a reused key whose exit floor memo was lost: error copy, no POST", async () => {
    mocks.fetchEarnVaultWithdrawalPreview
      .mockResolvedValueOnce({
        kind: "quoted",
        preview: {
          positionId: vedaPosition.id,
          assetsOut: "4.997",
          assetDecimals: 6,
          blockingIssues: [],
        },
      })
      .mockResolvedValue({
        kind: "quoted",
        preview: {
          positionId: vedaPosition.id,
          assetsOut: "2.5",
          assetDecimals: 6,
          blockingIssues: [],
        },
      });
    mocks.createEarnVaultWithdrawal.mockResolvedValueOnce({
      ok: false,
      error: "Bad gateway",
      status: 503,
      body: null,
    });

    const first = renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");
    await vi.waitFor(() => expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1));
    first.unmount();

    // The floor memo is bounded and stored separately from the key store, so
    // a busy session can evict a live key's floor while the key lives on.
    // Simulate that eviction at the storage tier.
    sessionStorage.removeItem("sdp:earn:vault-withdrawal:floor:v1");

    // enterVedaShares hands back real timers before its confirm click; the
    // second arm needs the fake clock again for the debounced quote.
    vi.useFakeTimers();
    renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");

    // The retry must NOT go out under a freshly derived floor: that pairs the
    // live key with a changed request, and the API's 409 retires the key while
    // the ambiguous first attempt may already have executed. The submission
    // stops with its own words instead, key untouched.
    expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/could not confirm the exact terms/);
    });
  });

  it("replays a kept key's minted shares when the live position value moved under it", async () => {
    mocks.fetchEarnVaultWithdrawalPreview.mockResolvedValue({
      kind: "quoted",
      preview: {
        positionId: vedaPosition.id,
        assetsOut: "4.997",
        assetDecimals: 6,
        blockingIssues: [],
      },
    });
    // A 5xx is the ambiguous case: the API may have recorded and broadcast the
    // exit, and the key stays live in the store either way.
    mocks.createEarnVaultWithdrawal
      .mockResolvedValueOnce({
        ok: false,
        error: "Bad gateway",
        status: 503,
        body: null,
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });

    const first = renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");
    await vi.waitFor(() => expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1));
    first.unmount();

    // The positions polls re-read the live value between the arms: the same
    // typed $5 now DERIVES a different share intent (4, not 5). A fingerprint
    // on the derived shares would miss the held key here and mint a SECOND
    // one — whose submit can exit again while the first attempt may already
    // have executed. Keyed on the typed dollars, the retry finds the key and
    // replays the minted shares verbatim.
    vi.useFakeTimers();
    renderModal(vi.fn(), { ...vedaPosition, tokenValue: "12.5" });
    await enterVedaShares("5");

    expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(2);
    expect(mocks.createEarnVaultWithdrawal.mock.calls[1][0]).toMatchObject({
      shares: "5",
      minAmountOut: "4.992003",
    });
    expect(mocks.createEarnVaultWithdrawal.mock.calls[1][1]).toBe(
      mocks.createEarnVaultWithdrawal.mock.calls[0][1]
    );
  });

  it("stops a reused key whose minted shares memo was lost: error copy, no POST", async () => {
    mocks.fetchEarnVaultWithdrawalPreview.mockResolvedValue({
      kind: "quoted",
      preview: {
        positionId: vedaPosition.id,
        assetsOut: "4.997",
        assetDecimals: 6,
        blockingIssues: [],
      },
    });
    mocks.createEarnVaultWithdrawal.mockResolvedValueOnce({
      ok: false,
      error: "Bad gateway",
      status: 503,
      body: null,
    });

    const first = renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");
    await vi.waitFor(() => expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1));
    first.unmount();

    // The shares memo is stored separately from the key store, so a refused
    // or evicted write can lose a live key's share intent. The retry must NOT
    // go out under a freshly derived intent — the API's fingerprint pins
    // `shares`, its refusal retires the key, and the next submit can exit a
    // second time. The submission stops with its own words instead.
    sessionStorage.removeItem("sdp:earn:vault-withdrawal:shares:v1");

    vi.useFakeTimers();
    renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");

    expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/could not confirm the exact terms/);
    });
  });

  it("re-quotes an exit floor older than the TTL at submit, then sends the reviewed floor", async () => {
    mocks.fetchEarnVaultWithdrawalPreview
      .mockResolvedValueOnce({
        kind: "quoted",
        preview: {
          positionId: vedaPosition.id,
          assetsOut: "4.997",
          assetDecimals: 6,
          blockingIssues: [],
        },
      })
      .mockResolvedValueOnce({
        kind: "quoted",
        preview: {
          positionId: vedaPosition.id,
          assetsOut: "4.9975",
          assetDecimals: 6,
          blockingIssues: [],
        },
      });
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "submitted", withdrawal: withdrawal("submitted") },
    });
    renderModal(vi.fn(), vedaPosition);
    await armVedaShares("5");
    // The clock passes the TTL without the auto-refresh timer firing — the
    // throttled-background-tab case the submit-time check exists for.
    vi.setSystemTime(Date.now() + VAULT_QUOTE_TTL_MS + 1000);
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await flushSubmission();

    // The fresh check ran, BEFORE the money moved…
    expect(mocks.fetchEarnVaultWithdrawalPreview).toHaveBeenCalledTimes(2);
    expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
    expect(mocks.fetchEarnVaultWithdrawalPreview.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.createEarnVaultWithdrawal.mock.invocationCallOrder[0]
    );
    // …and the floor sent is the one the user REVIEWED, freshly revalidated:
    // the still-satisfiable 4.992003, never a weaker floor off the 4.9975 rate.
    expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toEqual({
      positionId: vedaPosition.id,
      shares: "5",
      minAmountOut: "4.992003",
    });
    expect(screen.getByText("Withdrawal submitted")).toBeTruthy();
  });

  it("stops a stale submit whose fresh rate broke the exit floor: slippage copy, no POST", async () => {
    mocks.fetchEarnVaultWithdrawalPreview
      .mockResolvedValueOnce({
        kind: "quoted",
        preview: {
          positionId: vedaPosition.id,
          assetsOut: "4.997",
          assetDecimals: 6,
          blockingIssues: [],
        },
      })
      .mockResolvedValue({
        kind: "quoted",
        preview: {
          positionId: vedaPosition.id,
          assetsOut: "2.5",
          assetDecimals: 6,
          blockingIssues: [],
        },
      });
    renderModal(vi.fn(), vedaPosition);
    await armVedaShares("5");
    vi.setSystemTime(Date.now() + VAULT_QUOTE_TTL_MS + 1000);
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await flushSubmission();

    // The rate moved beyond the chosen tolerance while the quote sat stale:
    // friction lands HERE, before submit, never as a server refusal after.
    expect(mocks.createEarnVaultWithdrawal).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Increase the tolerance below/);
    expect(
      (screen.getByLabelText("Slippage tolerance (basis points)") as HTMLInputElement).value
    ).toBe("10");
    // The displayed quote re-syncs so the retry reviews the fresh floor.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.fetchEarnVaultWithdrawalPreview.mock.calls.length).toBeGreaterThanOrEqual(3);
    // 2.5 quoted × (1 − 10 bps), shown to the stablecoin's cent.
    expect(screen.getByText("$2.50")).toBeTruthy();
  });

  it("sends no floor and never quotes for a provider with no declared policy", async () => {
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "submitted", withdrawal: withdrawal("submitted") },
    });
    renderModal();
    screen.getByRole("dialog");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    await screen.findByText("Withdrawal submitted");
    expect(mocks.fetchEarnVaultWithdrawalPreview).not.toHaveBeenCalled();
    expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toEqual({
      positionId: position.id,
      shares: "5",
    });
    expect(screen.queryByText(/Slippage tolerance:/)).toBeNull();
  });
});
