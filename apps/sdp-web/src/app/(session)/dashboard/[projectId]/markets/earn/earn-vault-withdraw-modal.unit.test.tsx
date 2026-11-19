// @vitest-environment jsdom

import type { EarnVaultPosition, EarnVaultWithdrawal } from "@sdp/types/earn";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EnglishTestI18n } from "@/app/(session)/dashboard/[projectId]/markets/test-i18n";
import type { DashboardFetchResult } from "@/lib/dashboard-fetch";
import type { EarnVaultWithdrawalOutcome } from "./earn-program-data";
import { VAULT_QUOTE_DEBOUNCE_MS, VAULT_QUOTE_TTL_MS } from "./earn-vault-slippage";
import { EarnVaultWithdrawModal } from "./earn-vault-withdraw-modal";
import { resetVaultWithdrawalTrackingStateForTests } from "./earn-vault-withdraw-tracking";

/** The withdrawal POST's full answer — the result `createEarnVaultWithdrawal` resolves. */
type WithdrawalPostAnswer = DashboardFetchResult<EarnVaultWithdrawalOutcome>;

/** The store's raw entry shape, parsed rather than cast — saved input is external input. */
const storedEntriesSchema = z.array(
  z.object({
    id: z.string(),
    value: z.string(),
    claimedAt: z.number().optional(),
  })
);

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
  settlement?: React.ComponentProps<typeof EarnVaultWithdrawModal>["settlement"],
  redemptionMode?: React.ComponentProps<typeof EarnVaultWithdrawModal>["redemptionMode"]
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
          redemptionMode={redemptionMode}
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

  it("surfaces a current-build kept retry's saved terms on the review, like a legacy one's", async () => {
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

    // The position's live value moved between the arms: the review re-derives
    // the typed $5 into a DIFFERENT share intent at the moved rate. The kept
    // key's memos still hold the first attempt's shares and floor, and a
    // confirm here resubmits THOSE — the review must name them for a
    // this-build kept retry exactly as it does for an adopted legacy one.
    vi.useFakeTimers();
    renderModal(vi.fn(), { ...vedaPosition, tokenValue: "12.5" });
    await armVedaShares("5");

    expect(
      screen.getByText(
        /An earlier attempt to withdraw 5 SOL .*guaranteed minimum of \$4\.99\..*not the amount shown above/
      )
    ).toBeTruthy();
    // The rows above still show the live derivation of the typed $5 — which is
    // exactly why the notice exists: it, not the rows, names the saved request.
    expect(screen.getByText("$5.00")).toBeTruthy();
  });

  it("stops a confirm whose kept attempt was answered while the review sat open", async () => {
    primeQuote("4.997");
    // The first attempt's POST hangs: its key stays kept, and the second
    // arm's review promises to resubmit it while the answer is still out.
    let resolveFirst: ((answer: WithdrawalPostAnswer) => void) | undefined;
    mocks.createEarnVaultWithdrawal.mockImplementationOnce(
      () =>
        new Promise<WithdrawalPostAnswer>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const first = renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");
    await vi.waitFor(() => expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1));
    first.unmount();

    vi.useFakeTimers();
    renderModal(vi.fn(), vedaPosition);
    await armVedaShares("5");
    // The review names the kept attempt it promises to resubmit…
    expect(
      screen.getByText(/An earlier attempt to withdraw 5 SOL .*guaranteed minimum of \$4\.99\./)
    ).toBeTruthy();

    // …and then the first attempt's answer lands. The bookkeeping outlives the
    // unmounted first modal: the key retires and its memos go with it.
    resolveFirst?.({
      ok: true,
      status: 200,
      data: { kind: "submitted", withdrawal: withdrawal("submitted") },
    });
    await flushSubmission();

    // The confirm was approved as a replay of THAT attempt — never a fresh
    // exit over it. The stale review must not mint a new key now: the attempt
    // it stood for was answered, possibly executed.
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await flushSubmission();

    expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/could not confirm the exact terms/);
    });
    // The error's re-render read the memos fresh: the review no longer
    // promises a replay, so the notice is gone and the next confirm is
    // re-reviewed against current terms.
    expect(screen.queryByText(/An earlier attempt to withdraw/)).toBeNull();
  });

  it("claims the kept key without yielding: the retry reuses it while the first answer is out", async () => {
    primeQuote("4.997");
    // The first attempt's POST hangs — the key is live and unanswered when the
    // retry confirms.
    let resolveFirst: ((answer: WithdrawalPostAnswer) => void) | undefined;
    mocks.createEarnVaultWithdrawal
      .mockImplementationOnce(
        () =>
          new Promise<WithdrawalPostAnswer>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });

    const first = renderModal(vi.fn(), vedaPosition);
    await enterVedaShares("5");
    await vi.waitFor(() => expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1));
    first.unmount();

    vi.useFakeTimers();
    renderModal(vi.fn(), vedaPosition);
    await armVedaShares("5");
    expect(
      screen.getByText(/An earlier attempt to withdraw 5 SOL .*guaranteed minimum of \$4\.99\./)
    ).toBeTruthy();

    // Resolve → claim must run in one synchronous block on this path: an await
    // between them is the gap in which the first attempt's late answer can
    // retire the key and turn the claim into a SECOND minted key — the double
    // exit. The retry therefore goes out under the SAME key, with the request
    // that key was minted with, while the first attempt is still unanswered.
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await flushSubmission();

    expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(2);
    expect(mocks.createEarnVaultWithdrawal.mock.calls[1][0]).toEqual({
      positionId: vedaPosition.id,
      shares: "5",
      minAmountOut: "4.992003",
    });
    expect(mocks.createEarnVaultWithdrawal.mock.calls[1][1]).toBe(
      mocks.createEarnVaultWithdrawal.mock.calls[0][1]
    );

    // Both answers then land: the key retires and nothing kept remains.
    resolveFirst?.({
      ok: true,
      status: 200,
      data: { kind: "submitted", withdrawal: withdrawal("submitted") },
    });
    await flushSubmission();
    expect(sessionStorage.getItem("sdp:earn:vault-withdrawal:idempotency:v1")).not.toContain(
      mocks.createEarnVaultWithdrawal.mock.calls[0][1]
    );
    expect(sessionStorage.getItem("sdp:earn:vault-withdrawal:floor:v1")).not.toContain("4.992003");
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

  /**
   * The previous build's serialized identity —
   * `[projectId, positionId, DERIVED shares, toleranceBps, redemptionMode?]` —
   * which `seedLegacyKeptKey` stores as the entry's fingerprint. Mirrors the
   * tracker's `legacyIdentitySchema` tuple shapes, so a malformed fixture
   * fails typecheck instead of silently seeding an entry no scan can match.
   */
  type LegacyIdentityFixture =
    | [projectId: string | null, positionId: string, shares: string, toleranceBps: number | null]
    | [
        projectId: string | null,
        positionId: string,
        shares: string,
        toleranceBps: number | null,
        redemptionMode: "standard" | "instant",
      ];

  /**
   * The PREVIOUS build keyed its kept entries on the DERIVED shares and wrote
   * no format tag, so no fingerprint this build computes can ever find one
   * again — the retry of such an attempt must ADOPT it and replay its exact
   * request instead of minting a second key over it (which can exit again
   * while the first attempt may already have executed). Seeded here verbatim:
   * an entry in the key store under a shares-keyed identity, plus the floor
   * that build remembered under the same identity.
   */
  function seedLegacyKeptKey(input: {
    identity: LegacyIdentityFixture;
    key: string;
    claimedAt: number;
    /** The legacy floor memo entry; omitted when that memo lost it. */
    floor?: string | null;
  }) {
    const fingerprint = JSON.stringify(input.identity);
    const storeName = "sdp:earn:vault-withdrawal:idempotency:v1";
    const entries = sessionStorage.getItem(storeName);
    sessionStorage.setItem(
      storeName,
      JSON.stringify([
        ...(entries ? storedEntriesSchema.parse(JSON.parse(entries)) : []),
        { id: fingerprint, value: input.key, claimedAt: input.claimedAt },
      ])
    );
    if (input.floor !== undefined) {
      const floorName = "sdp:earn:vault-withdrawal:floor:v1";
      const floors = sessionStorage.getItem(floorName);
      sessionStorage.setItem(
        floorName,
        JSON.stringify({ ...(floors ? JSON.parse(floors) : {}), [fingerprint]: input.floor })
      );
    }
  }

  describe("a kept key the PREVIOUS build left (the fingerprint upgrade)", () => {
    /** The previous build's atomic identity: [project, position, DERIVED shares, tolerance, mode?]. */
    function legacyIdentity(shares: string, mode?: "standard" | "instant"): LegacyIdentityFixture {
      return mode === undefined
        ? ["prj_1", vedaPosition.id, shares, 10]
        : ["prj_1", vedaPosition.id, shares, 10, mode];
    }

    it("adopts the previous build's unresolved exit and replays it exactly", async () => {
      primeQuote("4.997");
      mocks.createEarnVaultWithdrawal.mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });
      // An unanswered $5 attempt from before the upgrade redeemed 4 shares at
      // tolerance 10: its key is kept under the shares-keyed identity, and the
      // floor it was minted with is still in the floor memo.
      seedLegacyKeptKey({
        identity: legacyIdentity("4"),
        key: "legacy-key",
        claimedAt: Date.now() - 60_000,
        floor: "4.31",
      });

      renderModal(vi.fn(), vedaPosition);
      // The retry types the same $5 — which this build can only look up under
      // the typed-quantity identity the legacy entry does not carry.
      await armVedaShares("5");
      // The adoption is SURFACED, never silent: the review names the recovered
      // shares and minted floor the confirm will actually send — not the $5
      // typed above.
      expect(
        screen.getByText(
          /An earlier attempt to withdraw 4 SOL .*guaranteed minimum of \$4\.31\..*not the amount shown above/
        )
      ).toBeTruthy();
      vi.useRealTimers();
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
      await flushSubmission();

      // The submit must NOT mint a second key over the unresolved attempt:
      // the replay carries the legacy key, the shares that key went out with
      // (parsed out of the legacy identity), and the floor it was minted with
      // — the first attempt's request, verbatim, which the API answers as a
      // replay either way.
      expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toEqual({
        positionId: vedaPosition.id,
        shares: "4",
        minAmountOut: "4.31",
      });
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][1]).toBe("legacy-key");
      expect(await screen.findByText("Withdrawal submitted")).toBeTruthy();

      // The answer retired the adopted key, and its memos went with it.
      expect(sessionStorage.getItem("sdp:earn:vault-withdrawal:idempotency:v1")).not.toContain(
        "legacy-key"
      );
      expect(sessionStorage.getItem("sdp:earn:vault-withdrawal:floor:v1")).not.toContain("4.31");
    });

    it("never adopts a legacy entry that appeared AFTER mount (the recovery is a snapshot)", async () => {
      primeQuote("4.997");
      mocks.createEarnVaultWithdrawal.mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });

      // Mounted with NOTHING legacy kept, and the previous build's entry only
      // then turns up underneath it (another tab's replay, a late write). The
      // recovery the review surfaces is the MOUNT-TIME scan's, so the submit
      // must not silently switch to an attempt the customer was never shown —
      // and the review has no notice to warn about.
      renderModal(vi.fn(), vedaPosition);
      seedLegacyKeptKey({
        identity: legacyIdentity("4"),
        key: "legacy-late",
        claimedAt: Date.now() - 60_000,
        floor: "4.31",
      });
      await enterVedaShares("5");

      expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toMatchObject({ shares: "5" });
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][1]).not.toBe("legacy-late");
      // The late entry is untouched — still kept for its own review.
      expect(sessionStorage.getItem("sdp:earn:vault-withdrawal:idempotency:v1")).toContain(
        "legacy-late"
      );
    });

    it("adopts the OLDEST legacy attempt first when the previous build left several", async () => {
      primeQuote("4.997");
      mocks.createEarnVaultWithdrawal.mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });
      // "Raise the tolerance and retry" minted a fresh key in the previous
      // build too, so several legacy attempts can be kept at once. Each submit
      // resolves one, oldest first.
      seedLegacyKeptKey({
        identity: legacyIdentity("4"),
        key: "legacy-older",
        claimedAt: Date.now() - 120_000,
        floor: "4.31",
      });
      seedLegacyKeptKey({
        identity: legacyIdentity("4.5"),
        key: "legacy-newer",
        claimedAt: Date.now() - 60_000,
        floor: "4.4",
      });

      const first = renderModal(vi.fn(), vedaPosition);
      await enterVedaShares("5");
      await flushSubmission();
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][1]).toBe("legacy-older");

      // The first replay retired the older key; the next submit resolves the
      // remaining one the same way.
      first.unmount();
      vi.useFakeTimers();
      renderModal(vi.fn(), vedaPosition);
      await enterVedaShares("5");
      await flushSubmission();
      expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(2);
      expect(mocks.createEarnVaultWithdrawal.mock.calls[1][1]).toBe("legacy-newer");
      expect(mocks.createEarnVaultWithdrawal.mock.calls[1][0]).toMatchObject({ shares: "4.5" });
    });

    it("stops instead of minting over a legacy attempt whose floor memo was lost", async () => {
      primeQuote("4.997");
      seedLegacyKeptKey({
        identity: legacyIdentity("4"),
        key: "legacy-key",
        claimedAt: Date.now() - 60_000,
        // No floor memo entry: an evicted or refused write lost it.
      });

      renderModal(vi.fn(), vedaPosition);
      await enterVedaShares("5");
      await flushSubmission();

      // The adopted attempt cannot be replayed without its minted floor, and
      // a fresh floor under its live key is the changed-request refusal that
      // unlocks a second exit. The submission stops, key untouched.
      expect(mocks.createEarnVaultWithdrawal).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(screen.getByRole("alert").textContent).toMatch(/could not confirm the exact terms/);
      });
      expect(sessionStorage.getItem("sdp:earn:vault-withdrawal:idempotency:v1")).toContain(
        "legacy-key"
      );
    });

    it("stops instead of minting when the recovered key was answered after mount", async () => {
      primeQuote("4.997");
      mocks.createEarnVaultWithdrawal.mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });
      seedLegacyKeptKey({
        identity: legacyIdentity("4"),
        key: "legacy-key",
        claimedAt: Date.now() - 60_000,
        floor: "4.31",
      });

      // Mounted on the kept legacy attempt — and then its answer arrives,
      // retiring it the way a PREVIOUS visit's adopted replay does when its
      // late answer lands after the customer navigated away and back.
      renderModal(vi.fn(), vedaPosition);
      const storeName = "sdp:earn:vault-withdrawal:idempotency:v1";
      const entries = storedEntriesSchema.parse(
        JSON.parse(sessionStorage.getItem(storeName) ?? "[]")
      );
      sessionStorage.setItem(
        storeName,
        JSON.stringify(entries.filter((entry) => entry.value !== "legacy-key"))
      );

      await enterVedaShares("5");

      // The confirm was approved as a REPLAY of the 4-share attempt — never a
      // fresh exit over it. The spent recovery stops the submission instead
      // of minting a new key under the typed quantity.
      expect(mocks.createEarnVaultWithdrawal).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(screen.getByRole("alert").textContent).toMatch(/could not confirm the exact terms/);
      });
      // The stale snapshot is refreshed away: the review no longer promises a
      // replay, so the next confirm is a normal, re-reviewed typed submit.
      expect(screen.queryByText(/An earlier attempt to withdraw/)).toBeNull();
    });

    it("mints a fresh key when the legacy attempt was for another position", async () => {
      primeQuote("4.997");
      mocks.createEarnVaultWithdrawal.mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });
      seedLegacyKeptKey({
        identity: ["prj_1", "earn_position_other", "4", 10],
        key: "legacy-key",
        claimedAt: Date.now() - 60_000,
        floor: "4.31",
      });

      renderModal(vi.fn(), vedaPosition);
      await enterVedaShares("5");
      await flushSubmission();

      // Another position's kept attempt is not this exit's first attempt: the
      // submit mints fresh, and the unrelated key is left alone.
      expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][1]).not.toBe("legacy-key");
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toMatchObject({ shares: "5" });
      expect(sessionStorage.getItem("sdp:earn:vault-withdrawal:idempotency:v1")).toContain(
        "legacy-key"
      );
    });

    it("mints a fresh key when only the redemption mode differs", async () => {
      primeQuote("4.997");
      mocks.createEarnVaultWithdrawal.mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });
      seedLegacyKeptKey({
        identity: legacyIdentity("4", "instant"),
        key: "legacy-key",
        claimedAt: Date.now() - 60_000,
        floor: "4.31",
      });

      // The body a standard-mode submit would send under the adopted key
      // carries THIS modal's mode — a changed request under a live key, whose
      // 422 would retire it while the instant attempt may have executed. The
      // mode is part of what the replay must match, so no adoption.
      renderModal(vi.fn(), vedaPosition, undefined, "standard");
      await enterVedaShares("5");
      await flushSubmission();

      expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][1]).not.toBe("legacy-key");
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toMatchObject({ shares: "5" });
    });

    it("never mistakes this build's kept key, tagged or not, for a legacy one", async () => {
      primeQuote("4.997");
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

      // A THIS-build attempt ($5, its key kept by the 5xx), then the customer
      // edits the amount and submits $6: a different withdrawal, whose submit
      // must mint fresh — the kept entry carries the format tag, so the legacy
      // scan refuses it.
      const first = renderModal(vi.fn(), vedaPosition);
      await enterVedaShares("5");
      await vi.waitFor(() => expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1));
      first.unmount();

      vi.useFakeTimers();
      renderModal(vi.fn(), vedaPosition);
      await enterVedaShares("6");
      await flushSubmission();

      expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(2);
      expect(mocks.createEarnVaultWithdrawal.mock.calls[1][1]).not.toBe(
        mocks.createEarnVaultWithdrawal.mock.calls[0][1]
      );
      expect(mocks.createEarnVaultWithdrawal.mock.calls[1][0]).toMatchObject({ shares: "6" });
      // The first attempt's key is still kept for ITS retry.
      expect(sessionStorage.getItem("sdp:earn:vault-withdrawal:idempotency:v1")).toContain(
        mocks.createEarnVaultWithdrawal.mock.calls[0][1]
      );
    });

    it("adopts a legacy provider-order key and replays its typed shares", async () => {
      const exactShares = "10.123456789";
      mocks.createEarnVaultWithdrawal.mockResolvedValue({
        ok: true,
        status: 200,
        data: { kind: "submitted", withdrawal: withdrawal("submitted") },
      });
      // A provider order keyed on its typed shares and kept with a
      // deliberately floorless memo (the provider declares no floor policy).
      seedLegacyKeptKey({
        identity: ["prj_1", vedaPosition.id, exactShares, null],
        key: "legacy-key",
        claimedAt: Date.now() - 60_000,
        floor: null,
      });

      renderModal(
        vi.fn(),
        { ...position, provider: "wisdomtree", label: "WisdomTree WTGXX", tokenValue: undefined },
        "provider_order"
      );
      screen.getByRole("dialog");
      fireEvent.change(screen.getByLabelText("Shares"), { target: { value: "6" } });
      vi.useRealTimers();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));
      await flushSubmission();

      // The typed 6 must not mint over the unresolved order: the replay goes
      // out under the legacy key with the order's own shares and no floor.
      expect(mocks.createEarnVaultWithdrawal).toHaveBeenCalledTimes(1);
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][0]).toEqual({
        positionId: vedaPosition.id,
        shares: exactShares,
      });
      expect(mocks.createEarnVaultWithdrawal.mock.calls[0][1]).toBe("legacy-key");
    });
  });
});
