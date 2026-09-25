// @vitest-environment jsdom

import type {
  EarnVaultParRedemptionPreview,
  EarnVaultParRedemptionTerms,
  EarnVaultPosition,
  EarnVaultWithdrawalRequestRecord,
} from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { flushSync } from "react-dom";
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
  fetchEarnVaultParRedemptionPreview: mocks.fetchPreview,
  useEarnVaultWithdrawalRequestOutcome: mocks.useRequestOutcome,
}));

vi.mock("./earn-flow-motion", () => ({
  EarnFlowStepper: () => null,
  EarnFlowTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EarnOutcomeMark: () => null,
}));

import { EarnVaultParRedemptionModal } from "./earn-vault-par-redemption-modal";

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PRIME_MINT = "prime";
const WYLDS_MINT = "wylds";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

const position: EarnVaultPosition = {
  id: "position_1",
  provider: "hastra",
  providerReference: PRIME_MINT,
  label: "Hastra PRIME",
  custodyWalletId: "wallet_1",
  tokenMint: USDC_MINT,
  shareMint: PRIME_MINT,
  createdAt: "2026-09-18T00:00:00.000Z",
  closedAt: null,
  feeSponsored: false,
  shares: "5000",
  withdrawableShares: "5000",
  tokenValue: "5000",
};

const terms: EarnVaultParRedemptionTerms = {
  intermediateMint: WYLDS_MINT,
  assetMint: USDC_MINT,
  minimumShares: "2000",
  shareDecimals: 6,
  assetDecimals: 6,
  cancelable: true,
  operatorSettled: true,
};

const preview: EarnVaultParRedemptionPreview = {
  positionId: position.id,
  mechanism: "operatorRedemption",
  shares: "2500",
  shareDecimals: 6,
  intermediateMint: WYLDS_MINT,
  intermediateAmount: "2500",
  assetMint: USDC_MINT,
  assets: "2500",
  assetDecimals: 6,
  blockingIssues: [],
};

function request(status: EarnVaultWithdrawalRequestRecord["status"] = "pending") {
  return {
    withdrawalRequestId: "request_1",
    positionId: position.id,
    provider: "hastra",
    providerReference: position.providerReference,
    ownerAddress: "owner_1",
    requestAddress: "request_account_1",
    status,
    mechanism: "operatorRedemption" as const,
    assetMint: USDC_MINT,
    shareMint: PRIME_MINT,
    intermediateMint: WYLDS_MINT,
    intermediateAmount: "2500",
    shares: "2500",
    quotedAssets: "2500",
    shareDecimals: 6,
    assetDecimals: 6,
    discountBps: null,
    nonce: null,
    creationTimestamp: null,
    maturityTimestamp: null,
    deadlineTimestamp: null,
    creationSignature: "request_signature",
    cancelSignature: null,
    closingSignature: null,
    assetsPaid: null,
    failureReason: null,
    fulfilledAt: null,
    cancelledAt: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  } satisfies EarnVaultWithdrawalRequestRecord;
}

function renderModal(
  overrides: Partial<React.ComponentProps<typeof EarnVaultParRedemptionModal>> = {}
) {
  const props = {
    environment: "sandbox" as const,
    onClose: vi.fn(),
    position,
    projectId: "project_1",
    terms,
    ...overrides,
  };
  return {
    ...render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <EarnVaultParRedemptionModal {...props} />
      </I18nProvider>
    ),
    props,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetIdempotencyKeyStoresForTests();
  sessionStorage.clear();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(IDEMPOTENCY_KEY);
  mocks.fetchPreview.mockResolvedValue({ kind: "ready", value: preview });
  mocks.useRequestOutcome.mockReturnValue(undefined);
  mocks.cancelRequest.mockResolvedValue({
    ok: true,
    status: 200,
    data: request("cancelling"),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EarnVaultParRedemptionModal", () => {
  function dispatchClick(element: HTMLElement): void {
    // Flush the discrete DOM update without wrapping the event in Testing
    // Library's act helper, which would also flush the passive preview
    // effect: the stale window must be observed before React's next
    // passive tick.
    flushSync(() => element.click());
  }

  it("refuses to submit changed shares under a retained stale preview", async () => {
    mocks.fetchPreview.mockImplementation(async (input: { shares: string }) => ({
      kind: "ready",
      value: {
        ...preview,
        shares: input.shares,
        assets: input.shares,
        intermediateAmount: input.shares,
      },
    }));
    mocks.createRequest.mockResolvedValue({
      ok: false,
      status: 503,
      error: "Operator redemption temporarily unavailable",
      body: null,
    });
    renderModal();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const review = await screen.findByRole("button", { name: "Request par redemption" });
    await waitFor(() => expect(screen.getByText("$2,500.00")).toBeTruthy());
    expect((review as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "3000" } });

    // Re-enter Review before the passive preview effect can run: the retained
    // quote for 2,500 shares must be hidden for the changed 3,000-share
    // intent, and submission must stay disabled until a quote for THAT
    // intent lands.
    dispatchClick(screen.getByRole("button", { name: "Continue" }));
    const submit = screen.getByRole("button", {
      name: "Request par redemption",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.queryByText("$2,500.00")).toBeNull();

    dispatchClick(submit);
    expect(mocks.createRequest).not.toHaveBeenCalled();

    // The supported flow survives: the fresh quote for the current input arms
    // submission and submits exactly the current intent.
    await waitFor(() => expect(screen.getByText("$3,000.00")).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: "Request par redemption" }) as HTMLButtonElement).disabled
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Request par redemption" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(1));
    expect(mocks.createRequest).toHaveBeenLastCalledWith(
      {
        positionId: position.id,
        shares: "3000",
        mechanism: "operatorRedemption",
      },
      IDEMPOTENCY_KEY
    );
  });

  it("discloses the off-chain batching threshold and submits an operator request", async () => {
    const onRequested = vi.fn();
    mocks.createRequest.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", withdrawalRequest: request() },
    });
    renderModal({ onRequested });

    const amount = screen.getByLabelText("Amount");
    fireEvent.change(amount, { target: { value: "1000" } });
    expect(screen.getByText(/requires at least 2,000 shares/)).toBeTruthy();
    expect(
      screen.getByText(/below Hastra's documented \$2,000 operator batch minimum/)
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true
    );

    fireEvent.change(amount, { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(mocks.fetchPreview).toHaveBeenCalledWith(
        {
          positionId: position.id,
          shares: "2500",
          mechanism: "operatorRedemption",
        },
        expect.any(AbortSignal)
      )
    );
    expect(await screen.findByText(/does not deliver USDC in the same transaction/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Request par redemption" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledTimes(1));
    expect(mocks.createRequest).toHaveBeenCalledWith(
      {
        positionId: position.id,
        shares: "2500",
        mechanism: "operatorRedemption",
      },
      IDEMPOTENCY_KEY
    );
    expect(onRequested).toHaveBeenCalledWith(request());
    expect(await screen.findByText("Awaiting operator")).toBeTruthy();
  });

  it("allows a pending par request to be cancelled before operator settlement", async () => {
    mocks.createRequest.mockResolvedValue({
      ok: true,
      status: 201,
      data: { kind: "submitted", withdrawalRequest: request() },
    });
    renderModal();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Request par redemption" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel and keep wYLDS" }));

    await waitFor(() =>
      expect(mocks.cancelRequest).toHaveBeenCalledWith("request_1", IDEMPOTENCY_KEY)
    );
    expect(await screen.findByText("Cancelling")).toBeTruthy();
  });
});
