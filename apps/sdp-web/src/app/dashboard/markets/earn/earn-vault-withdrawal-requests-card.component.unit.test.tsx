// @vitest-environment jsdom

import type { EarnVaultWithdrawalRequestRecord } from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "../test-i18n";

const mocks = vi.hoisted(() => ({
  cancelRequest: vi.fn(),
  useRequests: vi.fn(),
}));

vi.mock("./earn-program-data", () => ({
  cancelEarnVaultWithdrawalRequest: mocks.cancelRequest,
  useEarnVaultWithdrawalRequests: mocks.useRequests,
}));

import { EarnVaultWithdrawalRequestsCard } from "./earn-vault-withdrawal-requests-card";

const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

function request(
  withdrawalRequestId: string,
  status: EarnVaultWithdrawalRequestRecord["status"]
): EarnVaultWithdrawalRequestRecord {
  return {
    withdrawalRequestId,
    positionId: "position_1",
    provider: "veda",
    providerReference: "3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU",
    ownerAddress: "owner_1",
    requestAddress: `${withdrawalRequestId}_account`,
    status,
    assetMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    shareMint: "So11111111111111111111111111111111111111112",
    shares: "5",
    quotedAssets: "4.9875",
    shareDecimals: 6,
    assetDecimals: 6,
    discountBps: 25,
    nonce: "1",
    creationTimestamp: "1789722000",
    maturityTimestamp: "1789722060",
    deadlineTimestamp: "1789722420",
    creationSignature: "request_signature",
    cancelSignature: null,
    closingSignature: null,
    assetsPaid: null,
    failureReason: null,
    fulfilledAt: null,
    cancelledAt: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
}

function renderCard(onChanged = vi.fn()) {
  const renderUi = () => (
    <EnglishTestI18n>
      <EarnVaultWithdrawalRequestsCard onChanged={onChanged} />
    </EnglishTestI18n>
  );
  return {
    ...render(renderUi()),
    onChanged,
    renderUi,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Each mint returns a DISTINCT value, otherwise "the retry reused the key"
  // would pass against a constant mock that proves nothing.
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

describe("EarnVaultWithdrawalRequestsCard", () => {
  it("keeps active requests recoverable after the create modal is gone", async () => {
    const refresh = vi.fn();
    const pending = request("request_pending", "pending");
    const recoverable = request("request_recoverable", "expiredCancelable");
    mocks.useRequests.mockReturnValue({
      withdrawalRequests: [pending, recoverable],
      error: undefined,
      isLoading: false,
      refresh,
    });
    mocks.cancelRequest
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        error: "Recovery temporarily unavailable",
        body: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { ...recoverable, status: "cancelled" },
      });
    const view = renderCard();

    expect(screen.getByRole("heading", { name: "Withdrawal requests" })).toBeTruthy();
    expect(screen.getByText("Waiting for payment")).toBeTruthy();
    expect(screen.getByText("Shares ready")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Get shares back" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Get shares back" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Recovery temporarily unavailable"
    );
    expect(mocks.cancelRequest).toHaveBeenLastCalledWith(
      recoverable.withdrawalRequestId,
      IDEMPOTENCY_KEY
    );
    expect(refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Get shares back" }));
    await waitFor(() => expect(mocks.cancelRequest).toHaveBeenCalledTimes(2));
    // The UUID source now mints a fresh value for every call, so a retry can
    // only arrive under the SAME key if the card memoized the original one.
    expect(mocks.cancelRequest.mock.calls[1]).toEqual([
      recoverable.withdrawalRequestId,
      IDEMPOTENCY_KEY,
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(view.onChanged).not.toHaveBeenCalled();

    // A successful cancel POST is only a submitted recovery action. Refresh
    // balances after the authoritative open feed observes final cancellation.
    mocks.useRequests.mockReturnValue({
      withdrawalRequests: [pending],
      error: undefined,
      isLoading: false,
      refresh,
    });
    view.rerender(view.renderUi());
    await waitFor(() => expect(view.onChanged).toHaveBeenCalledTimes(1));

    view.rerender(view.renderUi());
    expect(view.onChanged).toHaveBeenCalledTimes(1);
  });

  it("refreshes once when solver fulfillment removes an active request", async () => {
    const refresh = vi.fn();
    const pending = request("request_pending", "pending");
    mocks.useRequests.mockReturnValue({
      withdrawalRequests: [pending],
      error: undefined,
      isLoading: false,
      refresh,
    });
    const view = renderCard();

    mocks.useRequests.mockReturnValue({
      withdrawalRequests: [],
      error: undefined,
      isLoading: false,
      refresh,
    });
    view.rerender(view.renderUi());

    await waitFor(() => expect(view.onChanged).toHaveBeenCalledTimes(1));
    expect(view.container.childElementCount).toBe(0);

    view.rerender(view.renderUi());
    expect(view.onChanged).toHaveBeenCalledTimes(1);
  });

  it("labels an unconfirmed request honestly and safely handles invalid provider epochs", () => {
    const creating = request("request_creating", "creating");
    creating.maturityTimestamp = "99999999999999999999";
    creating.deadlineTimestamp = "not-an-epoch";
    mocks.useRequests.mockReturnValue({
      withdrawalRequests: [creating],
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });

    renderCard();

    expect(screen.getByText("Confirming")).toBeTruthy();
    expect(screen.queryByText("Waiting for payment")).toBeNull();
    expect(
      screen.getByText(
        /4.9875 USDC expected · payment can start after Unavailable · get shares back after Unavailable/
      )
    ).toBeTruthy();
  });

  it("renders nothing once the server-side open feed is empty", () => {
    mocks.useRequests.mockReturnValue({
      withdrawalRequests: [],
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    });

    const { container, onChanged } = renderCard();

    expect(container.childElementCount).toBe(0);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
