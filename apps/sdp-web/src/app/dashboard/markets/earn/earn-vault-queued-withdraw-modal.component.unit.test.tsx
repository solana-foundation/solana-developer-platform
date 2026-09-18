// @vitest-environment jsdom

import type {
  EarnVaultPosition,
  EarnVaultQueuedWithdrawalPreview,
  EarnVaultQueuedWithdrawalTerms,
  EarnVaultWithdrawalRequestRecord,
} from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";

const mocks = vi.hoisted(() => ({
  cancelRequest: vi.fn(),
  createRequest: vi.fn(),
  fetchPreview: vi.fn(),
  useRequestOutcome: vi.fn(),
}));

vi.mock("./earn-program-data", () => ({
  cancelEarnVaultWithdrawalRequest: mocks.cancelRequest,
  createEarnVaultWithdrawalRequest: mocks.createRequest,
  fetchEarnVaultQueuedWithdrawalPreview: mocks.fetchPreview,
  useEarnVaultWithdrawalRequestOutcome: mocks.useRequestOutcome,
}));

vi.mock("./earn-flow-motion", () => ({
  EarnFlowStepper: () => null,
  EarnFlowTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EarnOutcomeMark: () => null,
}));

import { EarnVaultQueuedWithdrawModal } from "./earn-vault-queued-withdraw-modal";

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const FIRST_KEY = "11111111-1111-4111-8111-111111111111";
const SECOND_KEY = "22222222-2222-4222-8222-222222222222";
const THIRD_KEY = "33333333-3333-4333-8333-333333333333";

const position: EarnVaultPosition = {
  id: "position_1",
  provider: "veda",
  providerReference: "3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU",
  label: "Veda USDC",
  custodyWalletId: "wallet_1",
  tokenMint: USDC_MINT,
  shareMint: SHARE_MINT,
  createdAt: "2026-09-18T00:00:00.000Z",
  closedAt: null,
  feeSponsored: false,
  shares: "10",
  withdrawableShares: "10",
  tokenValue: "10",
};

const terms: EarnVaultQueuedWithdrawalTerms = {
  assetMint: USDC_MINT,
  allowWithdrawals: true,
  secondsToMaturity: 60,
  minimumSecondsToDeadline: 360,
  minimumDiscountBps: 25,
  maximumDiscountBps: 75,
  minimumShares: "1",
  shareDecimals: 6,
};

const preview: EarnVaultQueuedWithdrawalPreview = {
  positionId: position.id,
  assetMint: USDC_MINT,
  shares: "5",
  shareDecimals: 6,
  assets: "4.9875",
  assetDecimals: 6,
  discountBps: 25,
  maturityTimestamp: "1789722060",
  deadlineTimestamp: "1789722420",
  blockingIssues: [],
};

function request(
  status: EarnVaultWithdrawalRequestRecord["status"] = "pending"
): EarnVaultWithdrawalRequestRecord {
  return {
    withdrawalRequestId: "request_1",
    positionId: position.id,
    provider: "veda",
    providerReference: position.providerReference,
    ownerAddress: "owner_1",
    requestAddress: "request_account_1",
    status,
    assetMint: USDC_MINT,
    shareMint: SHARE_MINT,
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

function renderModal(
  overrides: Partial<React.ComponentProps<typeof EarnVaultQueuedWithdrawModal>> = {}
) {
  const props = {
    environment: "sandbox" as const,
    onClose: vi.fn(),
    position,
    projectId: "project_1",
    terms,
    ...overrides,
  };
  const renderUi = () => (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <EarnVaultQueuedWithdrawModal {...props} />
    </I18nProvider>
  );
  return { ...render(renderUi()), props, renderUi };
}

async function openReview(amount = "5") {
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(mocks.fetchPreview).toHaveBeenCalled());
  await screen.findByRole("button", { name: "Escrow shares and request" });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetIdempotencyKeyStoresForTests();
  sessionStorage.clear();
  mocks.fetchPreview.mockImplementation(async (input: { shares: string }) => ({
    kind: "ready",
    value: { ...preview, shares: input.shares },
  }));
  mocks.useRequestOutcome.mockReturnValue(undefined);
  mocks.cancelRequest.mockResolvedValue({ ok: true, status: 200, data: request("cancelled") });
  let minted = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    minted += 1;
    return (minted === 1 ? FIRST_KEY : minted === 2 ? SECOND_KEY : THIRD_KEY) as ReturnType<
      typeof crypto.randomUUID
    >;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EarnVaultQueuedWithdrawModal", () => {
  it("shows the unlock date when the live position reports zero withdrawable shares", () => {
    renderModal({
      position: {
        ...position,
        withdrawableShares: "0",
        unlockTimestamp: "1789722000",
      },
    });

    expect(
      screen.getByText(/These shares are locked until .*request is disabled until/i)
    ).toBeTruthy();
    expect(screen.queryByText("$0.00 available")).toBeNull();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("uses live queue terms and keeps one idempotency key until the intent changes", async () => {
    mocks.createRequest.mockResolvedValue({
      ok: false,
      status: 503,
      error: "Queue temporarily unavailable",
      body: null,
    });
    renderModal();

    expect((screen.getByLabelText("Discount (basis points)") as HTMLInputElement).value).toBe("25");
    expect((screen.getByLabelText("Solver window (seconds)") as HTMLInputElement).value).toBe(
      "360"
    );
    expect(screen.getByText("25–75 bps")).toBeTruthy();

    await openReview();
    expect(mocks.fetchPreview).toHaveBeenLastCalledWith(
      {
        positionId: position.id,
        shares: "5",
        discountBps: 25,
        deadlineSeconds: 360,
      },
      expect.any(AbortSignal)
    );

    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(1));
    expect(mocks.createRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ shares: "5" }),
      FIRST_KEY
    );

    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(2));
    expect(mocks.createRequest.mock.calls[1]?.[1]).toBe(FIRST_KEY);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.fetchPreview).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(3));
    expect(mocks.createRequest.mock.calls[2]).toEqual([
      expect.objectContaining({ shares: "10" }),
      SECOND_KEY,
    ]);
  });

  it("explains provider preview blockers instead of silently disabling submission", async () => {
    mocks.fetchPreview.mockResolvedValue({
      kind: "ready",
      value: {
        ...preview,
        blockingIssues: [{ code: "minimum_shares", message: "Request at least one vault share." }],
      },
    });
    renderModal();

    await openReview();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The provider cannot accept this request:");
    expect(alert.textContent).toContain("Request at least one vault share.");
    expect(
      (screen.getByRole("button", { name: "Escrow shares and request" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("shows the polled recovery state and submits a deadline-safe cancellation", async () => {
    const submitted = request("pending");
    const recoverable = request("expiredCancelable");
    const onRequested = vi.fn();
    const onSettled = vi.fn();
    mocks.createRequest.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", withdrawalRequest: submitted },
    });
    mocks.useRequestOutcome.mockReturnValue(recoverable);
    renderModal({ onRequested, onSettled });

    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));

    expect(await screen.findByText("Recovery available")).toBeTruthy();
    expect(mocks.createRequest).toHaveBeenCalledWith(expect.any(Object), FIRST_KEY);
    expect(mocks.useRequestOutcome).toHaveBeenCalledWith(submitted.withdrawalRequestId, onSettled);
    expect(onRequested).toHaveBeenCalledWith(submitted);

    fireEvent.click(screen.getByRole("button", { name: "Cancel and recover shares" }));
    await waitFor(() =>
      expect(mocks.cancelRequest).toHaveBeenCalledWith(submitted.withdrawalRequestId, SECOND_KEY)
    );
  });

  it("forwards server-observed solver fulfillment to the settlement callback", async () => {
    const submitted = request("pending");
    const fulfilled = request("fulfilled");
    fulfilled.assetsPaid = "4.9875";
    fulfilled.fulfilledAt = "2026-09-18T00:01:00.000Z";
    const onSettled = vi.fn();
    mocks.createRequest.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", withdrawalRequest: submitted },
    });
    mocks.useRequestOutcome.mockReturnValue(fulfilled);
    renderModal({ onSettled });

    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));

    expect(await screen.findByText("Fulfilled")).toBeTruthy();
    const observedSettlement = mocks.useRequestOutcome.mock.calls.at(-1)?.[1];
    expect(observedSettlement).toBe(onSettled);
    observedSettlement?.(fulfilled);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(fulfilled);
  });

  it.each([
    [
      "creating" as const,
      "Confirming request",
      "Submission is still being confirmed. SDP has not yet confirmed that the request is on chain.",
    ],
    [
      "closedOrUnknown" as const,
      "Checking close event",
      "The request account is closed. SDP is checking its close event to determine the final outcome.",
    ],
    [
      "failed" as const,
      "Failed",
      "The queued withdrawal did not complete. Review the recorded reason before trying again.",
    ],
    [
      "cancelling" as const,
      "Recovering shares",
      "The request is on chain. SDP will keep observing it after this window closes.",
    ],
  ])("renders honest %s status copy", async (status, label, body) => {
    const submitted = request(status);
    if (status === "failed") submitted.failureReason = "The provider rejected the request.";
    mocks.createRequest.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", withdrawalRequest: submitted },
    });
    renderModal();

    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));

    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
    expect(
      screen.queryByText(
        "The provider's solver, not SDP, controls fulfilment. If it does not fulfil before the deadline, the shares remain recoverable through Cancel and recover shares."
      )
    ).toBeNull();
    if (status !== "cancelling") {
      expect(
        screen.queryByText(
          "The request is on chain. SDP will keep observing it after this window closes."
        )
      ).toBeNull();
    }
    if (status === "failed") {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Failure reason");
      expect(alert.textContent).toContain("The provider rejected the request.");
    }
  });

  it("uses a fresh cancellation key when reconciliation reopens recovery", async () => {
    const submitted = request("pending");
    const recoverable = request("expiredCancelable");
    const cancelling = request("cancelling");
    cancelling.updatedAt = "2026-09-18T00:01:00.000Z";
    const reopened = request("expiredCancelable");
    reopened.updatedAt = "2026-09-18T00:02:00.000Z";
    mocks.createRequest.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", withdrawalRequest: submitted },
    });
    mocks.cancelRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: cancelling })
      .mockResolvedValueOnce({ ok: true, status: 200, data: request("cancelling") });
    mocks.useRequestOutcome.mockReturnValue(recoverable);
    const view = renderModal();

    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));
    await screen.findByText("Recovery available");
    fireEvent.click(screen.getByRole("button", { name: "Cancel and recover shares" }));
    await waitFor(() => expect(mocks.cancelRequest).toHaveBeenCalledTimes(1));
    expect(mocks.cancelRequest.mock.calls[0]?.[1]).toBe(SECOND_KEY);
    expect(await screen.findByText("Recovering shares")).toBeTruthy();

    mocks.useRequestOutcome.mockReturnValue(reopened);
    view.rerender(view.renderUi());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel and recover shares" })).toBeTruthy()
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel and recover shares" }));
    await waitFor(() => expect(mocks.cancelRequest).toHaveBeenCalledTimes(2));
    expect(mocks.cancelRequest.mock.calls[1]?.[1]).toBe(THIRD_KEY);
  });

  it("renders a policy approval hold without claiming shares were escrowed", async () => {
    const onRequested = vi.fn();
    mocks.createRequest.mockResolvedValue({
      ok: true,
      status: 202,
      data: {
        kind: "approval_pending",
        message: "Approval required",
        approvalRequestId: "approval_request_1",
        walletOperationId: "wallet_operation_1",
      },
    });
    renderModal({ onRequested });

    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));

    expect(await screen.findByText("Withdrawal pending approval")).toBeTruthy();
    expect(screen.getByText("approval_request_1")).toBeTruthy();
    expect(screen.getByText("wallet_operation_1")).toBeTruthy();
    expect(onRequested).not.toHaveBeenCalled();
    expect(screen.queryByText("Queued withdrawal requested")).toBeNull();
  });

  it("reuses an approval-held key after the modal unmounts and reopens", async () => {
    mocks.createRequest.mockResolvedValue({
      ok: true,
      status: 202,
      data: {
        kind: "approval_pending",
        message: "Approval required",
        approvalRequestId: "approval_request_1",
      },
    });

    const first = renderModal();
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));
    await screen.findByText("Withdrawal pending approval");
    first.unmount();

    renderModal();
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Escrow shares and request" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(2));

    expect(mocks.createRequest.mock.calls[0]?.[1]).toBe(FIRST_KEY);
    expect(mocks.createRequest.mock.calls[1]?.[1]).toBe(FIRST_KEY);
  });
});
