// @vitest-environment jsdom

import type { EarnPortfolioWithdrawal } from "@sdp/types/earn";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "@/app/dashboard/[projectId]/markets/test-i18n";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
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
vi.mock("@sdp/types/provider-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/provider-access")>()),
  earnProgramSolanaPayoutTokens: vi.fn(() => ["usdc"]),
}));

const DESTINATION = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const FIRST_KEY = "11111111-1111-4111-8111-111111111111";
const SECOND_KEY = "22222222-2222-4222-8222-222222222222";
const THIRD_KEY = "33333333-3333-4333-8333-333333333333";

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
  resetIdempotencyKeyStoresForTests();
  sessionStorage.clear();
  let minted = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    minted += 1;
    return (minted === 1 ? FIRST_KEY : minted === 2 ? SECOND_KEY : THIRD_KEY) as ReturnType<
      typeof crypto.randomUUID
    >;
  });
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  // An unknown outcome (409 IDEMPOTENCY_KEY_OUTCOME_UNKNOWN) may have already
  // paid out. The key stays kept, so the retry is answered by the API's replay
  // instead of paying a second time, and the reader is sent to the ledger list.
  it("keeps the key on an unknown outcome and tells the user to check the list", async () => {
    mocks.createEarnWithdrawal.mockResolvedValue({
      ok: false,
      status: 409,
      error: "outcome unknown",
      code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN",
      body: null,
    });
    renderModal();

    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    expect(
      await screen.findByText(
        "We couldn’t confirm whether this was created — check the list before trying again."
      )
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await waitFor(() => expect(mocks.createEarnWithdrawal).toHaveBeenCalledTimes(2));
    expect(mocks.createEarnWithdrawal.mock.calls.map((call) => call[2])).toEqual([
      FIRST_KEY,
      FIRST_KEY,
    ]);
  });

  // The reload case the ref-based key could not survive: a recorded withdrawal
  // retires its key, so the same intent entered again is a DELIBERATE second
  // withdrawal under a fresh key — while an ambiguous attempt's key is kept
  // across a remount, and its retry replays instead of paying twice.
  it("retires a recorded withdrawal's key and keeps an ambiguous one across a remount", async () => {
    mocks.createEarnWithdrawal
      // First attempt: the response never arrives (network failure) — the key
      // is kept, the retry under it replays.
      .mockResolvedValueOnce({ ok: false, error: "Network error", status: null, body: null })
      // Second attempt (same key): recorded.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: { withdrawal: withdrawal("processing") } },
      });
    const { onWithdrawalCreated } = renderModal();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await screen.findByText("Withdrawal submitted");
    expect(onWithdrawalCreated).toHaveBeenCalledWith("wref_1");
    expect(mocks.createEarnWithdrawal.mock.calls.map((call) => call[2])).toEqual([
      FIRST_KEY,
      FIRST_KEY,
    ]);

    // A remount of the same intent mints a FRESH key: the first withdrawal was
    // recorded, so this is a new intended withdrawal, not its replay.
    cleanup();
    renderModal();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await waitFor(() => expect(mocks.createEarnWithdrawal).toHaveBeenCalledTimes(3));
    expect(mocks.createEarnWithdrawal.mock.calls[2]?.[2]).toBe(SECOND_KEY);
  });
});
