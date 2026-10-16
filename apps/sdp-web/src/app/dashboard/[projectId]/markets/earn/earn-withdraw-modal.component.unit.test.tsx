// @vitest-environment jsdom

import type { EarnPortfolioWithdrawal } from "@sdp/types";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "../test-i18n";
import { EarnWithdrawModal } from "./earn-withdraw-modal";

const mocks = vi.hoisted(() => ({
  createEarnWithdrawal: vi.fn(),
  previewEarnWithdrawal: vi.fn(),
  useEarnWithdrawalOutcomeToast: vi.fn(),
}));

vi.mock("./earn-program-data", () => ({
  createEarnWithdrawal: mocks.createEarnWithdrawal,
  previewEarnWithdrawal: mocks.previewEarnWithdrawal,
  useEarnWithdrawalOutcomeToast: mocks.useEarnWithdrawalOutcomeToast,
}));

// The shared registry ships every program-style lane closed, so every real
// provider id fails the form closed and the submit path below is unreachable
// in a test. Opening one lane here is what lets the lock itself be exercised.
vi.mock("@sdp/types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types")>()),
  earnProgramSolanaPayoutTokens: vi.fn(() => ["usdc"]),
}));

const DESTINATION = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";

function withdrawal(status: EarnPortfolioWithdrawal["status"]): EarnPortfolioWithdrawal {
  return {
    withdrawalRef: "wref_1",
    status,
    destinationAddress: DESTINATION,
    createdAt: "2026-09-17T00:00:00.000Z",
  };
}

function renderModal() {
  const onWithdrawalCreated = vi.fn();
  render(
    <EnglishTestI18n>
      <EarnWithdrawModal
        programId="earn_program_1"
        provider="upshift"
        onClose={vi.fn()}
        onWithdrawalCreated={onWithdrawalCreated}
      />
    </EnglishTestI18n>
  );
  return { onWithdrawalCreated };
}

function fillForm() {
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.50" } });
  fireEvent.change(screen.getByLabelText("Destination address"), {
    target: { value: DESTINATION },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The on-open liquidity read and the debounced amount preview both answer
  // with the lane's ceiling; a valid-shaped amount stays valid while they run.
  mocks.previewEarnWithdrawal.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      data: {
        preview: { feeUsd: "0.00", withdrawableUsd: "20.00", totalUsdAfterWithdrawal: "180.00" },
      },
    },
  });
});

afterEach(cleanup);

describe("EarnWithdrawModal submit lock", () => {
  /**
   * The pre-await ref lock exists because a second click that lands before the
   * re-render commits re-enters `submit` with the stale `submitting === false`
   * closure — the state guard alone cannot stop it, and each entry sends its
   * own POST. Replayed here as two clicks in one task, before any React flush:
   * exactly one request may leave, and the lock must RELEASE afterwards so a
   * legitimate retry after a failure still reaches the API.
   */
  it("sends one request for a double submit and still allows a later retry", async () => {
    let resolveCreate: (result: {
      ok: false;
      error: string;
      status: number | null;
      body: unknown;
    }) => void = () => {};
    // The first confirm hangs on a deferred refusal, holding the in-flight
    // window open so both clicks land inside it.
    mocks.createEarnWithdrawal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        })
    );
    // The retry then succeeds, proving recovery, not just refusal handling.
    mocks.createEarnWithdrawal.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: { withdrawal: withdrawal("processing") } },
    });
    const { onWithdrawalCreated } = renderModal();

    fillForm();
    const confirm = screen.getByRole("button", { name: "Confirm withdrawal" });
    // Two clicks inside ONE synchronous act, dispatched as raw events: React
    // flushes nothing between them, so the second entry really does run the
    // stale `submitting === false` closure the lock exists for.
    act(() => {
      const click = () =>
        confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      click();
      click();
    });

    // One intended withdrawal, one request: the second entry died on the ref.
    expect(mocks.createEarnWithdrawal).toHaveBeenCalledTimes(1);

    resolveCreate({ ok: false, error: "upstream unavailable", status: 500, body: null });
    expect(await screen.findByRole("alert")).toBeTruthy();

    // The failed attempt released the lock, so a retry really re-arms.
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await screen.findByText("Withdrawal submitted");
    expect(mocks.createEarnWithdrawal).toHaveBeenCalledTimes(2);
    expect(onWithdrawalCreated).toHaveBeenCalledWith("wref_1");
  });
});
