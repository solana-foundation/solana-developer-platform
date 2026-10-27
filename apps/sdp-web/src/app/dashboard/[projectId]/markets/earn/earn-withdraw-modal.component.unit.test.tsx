// @vitest-environment jsdom

import type { EarnPortfolioWithdrawal } from "@sdp/types/earn";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const rendered = render(
    <EnglishTestI18n>
      <EarnWithdrawModal
        programId="earn_program_1"
        provider="upshift"
        onClose={vi.fn()}
        onWithdrawalCreated={onWithdrawalCreated}
      />
    </EnglishTestI18n>
  );
  return { onWithdrawalCreated, rendered };
}

function fillForm() {
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.50" } });
  fireEvent.change(screen.getByLabelText("Destination address"), {
    target: { value: DESTINATION },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The durable request-id store is what carries an id across retries now, so
  // every test starts with an empty store and a clean scope.
  sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
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

describe("EarnWithdrawModal request-id durability", () => {
  /**
   * The request id identifies ONE intended withdrawal, and a 5xx answer is
   * ambiguous: the provider may already have recorded the payout. The id
   * therefore has to outlive the modal AND the page — a ref cannot, which is
   * what let a reload turn one ambiguous failure into a second withdrawal.
   */
  it("re-claims the same requestId across a remount, so a reload cannot pay twice", async () => {
    mocks.createEarnWithdrawal
      // First attempt: an ambiguous failure — the answer never landed.
      .mockResolvedValueOnce({
        ok: false,
        error: "upstream unavailable",
        status: 500,
        body: null,
      })
      // The re-entry after the reload succeeds once the same id replays.
      .mockResolvedValue({
        ok: true,
        status: 200,
        data: { data: { withdrawal: withdrawal("processing") } },
      });

    const first = renderModal();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.createEarnWithdrawal).toHaveBeenCalledTimes(1);
    first.rendered.unmount();

    // A fresh mount of the same intent — everything a reload leaves behind.
    renderModal();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await screen.findByText("Withdrawal submitted");

    expect(mocks.createEarnWithdrawal).toHaveBeenCalledTimes(2);
    expect(mocks.createEarnWithdrawal.mock.calls[1][1].requestId).toBe(
      mocks.createEarnWithdrawal.mock.calls[0][1].requestId
    );
  });

  it("mints a fresh requestId when the intended withdrawal changes", async () => {
    mocks.createEarnWithdrawal
      .mockResolvedValueOnce({
        ok: false,
        error: "upstream unavailable",
        status: 500,
        body: null,
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        data: { data: { withdrawal: withdrawal("processing") } },
      });
    renderModal();

    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    // A corrected destination is a DIFFERENT withdrawal — it must never be
    // answered under the failed attempt's id.
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await screen.findByText("Withdrawal submitted");

    expect(mocks.createEarnWithdrawal).toHaveBeenCalledTimes(2);
    expect(mocks.createEarnWithdrawal.mock.calls[1][1].requestId).not.toBe(
      mocks.createEarnWithdrawal.mock.calls[0][1].requestId
    );
    expect(mocks.createEarnWithdrawal.mock.calls[1][1].destinationAddress).toBe(
      "3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU"
    );
  });
});
