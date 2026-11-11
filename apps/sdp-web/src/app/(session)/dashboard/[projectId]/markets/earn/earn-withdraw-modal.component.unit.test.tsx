// @vitest-environment jsdom

import type { EarnPortfolioWithdrawal } from "@sdp/types/earn";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "@/app/(session)/dashboard/[projectId]/markets/test-i18n";
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
        projectId="prj_test"
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
  // The store is what carries a withdrawal's key between submits now, so it
  // has to start empty; and each mint returns a DISTINCT value, otherwise
  // "the retry reused the key" would pass against a constant mock that proves
  // nothing.
  resetIdempotencyKeyStoresForTests();
  sessionStorage.clear();
  let minted = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    minted += 1;
    return `11111111-1111-4111-8111-11111111111${minted}` as ReturnType<typeof crypto.randomUUID>;
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
    // Both attempts rode ONE key claimed from the persisted store — the 500 is
    // an outcome-unknown answer, so the key stays kept and the retry replays
    // the first attempt instead of paying a second one. And the input carries
    // no `requestId`: the key travels as the `Idempotency-Key` header alone,
    // because the API refuses a withdrawal that names both sources.
    const [, firstInput, firstKey] = mocks.createEarnWithdrawal.mock.calls[0];
    const [, secondInput, secondKey] = mocks.createEarnWithdrawal.mock.calls[1];
    expect(firstKey).toBe(secondKey);
    expect(firstInput).toEqual({
      amountUsd: "12.50",
      token: "usdc",
      destinationAddress: DESTINATION,
    });
    expect(secondInput).toEqual(firstInput);
  });
});
