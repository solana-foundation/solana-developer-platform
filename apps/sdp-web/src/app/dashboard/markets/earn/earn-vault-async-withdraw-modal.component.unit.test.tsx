// @vitest-environment jsdom

import type { EarnVaultPosition, EarnVaultWithdrawalRequestRecord } from "@sdp/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withdrawProps: undefined as Record<string, unknown> | undefined,
}));

const request: EarnVaultWithdrawalRequestRecord = {
  withdrawalRequestId: "request_1",
  positionId: "position_1",
  provider: "provider_a",
  providerReference: "vault",
  ownerAddress: "owner",
  requestAddress: "request",
  status: "pending",
  assetMint: "asset",
  shareMint: "share",
  shares: "5",
  quotedAssets: "4.9",
  shareDecimals: 6,
  assetDecimals: 6,
  discountBps: 20,
  nonce: "1",
  creationTimestamp: "1",
  maturityTimestamp: "2",
  deadlineTimestamp: "3",
  creationSignature: "signature",
  cancelSignature: null,
  closingSignature: null,
  assetsPaid: null,
  failureReason: null,
  fulfilledAt: null,
  cancelledAt: null,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

vi.mock("./earn-vault-queued-withdraw-modal", () => ({
  EarnVaultQueuedWithdrawModal: (props: {
    onRequested?: (value: EarnVaultWithdrawalRequestRecord) => void;
    onSettled?: (value: EarnVaultWithdrawalRequestRecord) => void;
  }) => (
    <>
      <button onClick={() => props.onRequested?.(request)} type="button">
        request
      </button>
      <button onClick={() => props.onSettled?.(request)} type="button">
        settle
      </button>
    </>
  ),
}));
vi.mock("./earn-vault-withdraw-modal", () => ({
  EarnVaultWithdrawModal: (props: Record<string, unknown>) => {
    mocks.withdrawProps = props;
    return <div>provider order flow</div>;
  },
}));

import { EarnVaultAsyncWithdrawModal } from "./earn-vault-async-withdraw-modal";

const position: EarnVaultPosition = {
  id: "position_1",
  provider: "provider_a",
  providerReference: "vault",
  label: "Provider vault",
  custodyWalletId: "wallet_1",
  tokenMint: "asset",
  shareMint: "share",
  createdAt: "2026-09-18T00:00:00.000Z",
  closedAt: null,
  feeSponsored: false,
};

const route = {
  kind: "queue" as const,
  summary: {
    titleKey: "DashboardEarn.exitRoute.asyncTitle" as const,
    messageKey: "DashboardEarn.exitRoute.asyncDescription" as const,
    values: {},
  },
  waitSeconds: 60,
  terms: {
    assetMint: "asset",
    allowWithdrawals: true,
    secondsToMaturity: 60,
    minimumSecondsToDeadline: 300,
    minimumDiscountBps: 10,
    maximumDiscountBps: 100,
    minimumShares: "1",
    shareDecimals: 6,
  },
};

afterEach(() => {
  mocks.withdrawProps = undefined;
  cleanup();
});

describe("EarnVaultAsyncWithdrawModal", () => {
  it("wraps queue records in mechanism-discriminated product events", () => {
    const onRequested = vi.fn();
    const onSettled = vi.fn();
    render(
      <EarnVaultAsyncWithdrawModal
        environment="sandbox"
        onClose={vi.fn()}
        onRequested={onRequested}
        onSettled={onSettled}
        position={position}
        projectId="project_1"
        route={route}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "request" }));
    fireEvent.click(screen.getByRole("button", { name: "settle" }));

    expect(onRequested).toHaveBeenCalledWith({ kind: "queue", request });
    expect(onSettled).toHaveBeenCalledWith({ kind: "queue", request });
  });

  it("renders a provider order with the standard redemption form in delayed mode", () => {
    const onMovementUpdated = vi.fn();
    const onWithdrawn = vi.fn();
    render(
      <EarnVaultAsyncWithdrawModal
        environment="production"
        onClose={vi.fn()}
        onMovementUpdated={onMovementUpdated}
        onWithdrawn={onWithdrawn}
        position={position}
        projectId="project_1"
        route={{
          kind: "provider_order",
          summary: {
            titleKey: "DashboardEarn.exitRoute.providerOrderTitle",
            messageKey: "DashboardEarn.exitRoute.providerOrderDescription",
            values: {},
          },
        }}
      />
    );

    expect(screen.getByText("provider order flow")).toBeTruthy();
    expect(mocks.withdrawProps).toMatchObject({
      settlement: "provider_order",
      onMovementUpdated,
      onWithdrawn,
    });
  });
});
