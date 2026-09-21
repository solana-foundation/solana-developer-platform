// @vitest-environment jsdom

import type { EarnVaultPosition } from "@sdp/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const mocks = vi.hoisted(() => ({
  fetchOptions: vi.fn(),
  asyncModal: undefined as
    | {
        onSettled?: (event: { kind: "queue"; request: { withdrawalRequestId: string } }) => void;
        route?: { kind: "queue" | "provider_order" };
      }
    | undefined,
}));

vi.mock("./earn-program-data", () => ({
  fetchEarnVaultWithdrawalOptions: mocks.fetchOptions,
}));
vi.mock("./earn-vault-withdraw-modal", () => ({
  EarnVaultWithdrawModal: () => <div>instant flow</div>,
}));
vi.mock("./earn-vault-async-withdraw-modal", () => ({
  EarnVaultAsyncWithdrawModal: (props: {
    onSettled?: (event: { kind: "queue"; request: { withdrawalRequestId: string } }) => void;
    route: { kind: "queue" | "provider_order" };
  }) => {
    mocks.asyncModal = props;
    return <div>async flow</div>;
  },
}));

import { EarnVaultExitModal } from "./earn-vault-exit-modal";

const position: EarnVaultPosition = {
  id: "position_1",
  provider: "veda",
  providerReference: "3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU",
  label: "Veda USDC",
  custodyWalletId: "wallet_1",
  tokenMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  shareMint: "So11111111111111111111111111111111111111112",
  createdAt: "2026-09-18T00:00:00.000Z",
  closedAt: null,
  feeSponsored: false,
  shares: "10",
  withdrawableShares: "10",
  tokenValue: "10",
};

function renderModal(overrides: Partial<React.ComponentProps<typeof EarnVaultExitModal>> = {}) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <EarnVaultExitModal
        environment="sandbox"
        onClose={vi.fn()}
        position={position}
        projectId="project_1"
        {...overrides}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.asyncModal = undefined;
});
afterEach(cleanup);

describe("EarnVaultExitModal", () => {
  it("does not auto-select when instant and asynchronous routes are both available", async () => {
    mocks.fetchOptions.mockResolvedValue({
      kind: "ready",
      value: {
        positionId: position.id,
        instant: true,
        providerOrder: false,
        queued: true,
        withdrawAuthority: "11111111111111111111111111111111",
        queueState: "queue",
        queueAsset: {
          assetMint: position.tokenMint,
          allowWithdrawals: true,
          secondsToMaturity: 60,
          minimumSecondsToDeadline: 120,
          minimumDiscountBps: 0,
          maximumDiscountBps: 100,
          minimumShares: "1",
          shareDecimals: 6,
        },
      },
    });

    renderModal();

    expect(await screen.findByRole("button", { name: /Withdraw now/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Request withdrawal/ })).toBeTruthy();
    expect(screen.getByText(/about 1 minute/)).toBeTruthy();
    expect(screen.queryByText(/about 0 seconds/)).toBeNull();
    expect(screen.queryByText("instant flow")).toBeNull();
    expect(screen.queryByText("async flow")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Request withdrawal/ }));
    expect(await screen.findByText("async flow")).toBeTruthy();
  });

  it("forwards asynchronous settlement so Treasury can refresh custody balances", async () => {
    const onAsyncRequestSettled = vi.fn();
    mocks.fetchOptions.mockResolvedValue({
      kind: "ready",
      value: {
        positionId: position.id,
        instant: false,
        providerOrder: false,
        queued: true,
        withdrawAuthority: "11111111111111111111111111111111",
        queueState: "queue",
        queueAsset: {
          assetMint: position.tokenMint,
          allowWithdrawals: true,
          secondsToMaturity: 60,
          minimumSecondsToDeadline: 120,
          minimumDiscountBps: 0,
          maximumDiscountBps: 100,
          minimumShares: "1",
          shareDecimals: 6,
        },
      },
    });

    renderModal({ onAsyncRequestSettled });

    expect(await screen.findByText("async flow")).toBeTruthy();
    expect(mocks.asyncModal?.onSettled).toBe(onAsyncRequestSettled);
  });

  it("enters the sole available route without inventing a fallback", async () => {
    mocks.fetchOptions.mockResolvedValue({
      kind: "ready",
      value: {
        positionId: position.id,
        instant: true,
        providerOrder: false,
        queued: false,
        withdrawAuthority: null,
        queueState: null,
        queueAsset: null,
      },
    });

    renderModal();

    expect(await screen.findByText("instant flow")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("async flow")).toBeNull());
  });

  it("auto-selects a provider-settled redemption without advertising an instant payout", async () => {
    mocks.fetchOptions.mockResolvedValue({
      kind: "ready",
      value: {
        positionId: position.id,
        instant: false,
        providerOrder: true,
        queued: false,
        withdrawAuthority: null,
        queueState: null,
        queueAsset: null,
      },
    });

    renderModal({
      position: { ...position, provider: "wisdomtree", label: "WisdomTree WTGXX" },
    });

    expect(await screen.findByText("async flow")).toBeTruthy();
    expect(mocks.asyncModal?.route?.kind).toBe("provider_order");
    expect(screen.queryByText("instant flow")).toBeNull();
    expect(screen.queryByRole("button", { name: /Instant withdrawal/ })).toBeNull();
    expect(screen.queryByText(/same transaction/i)).toBeNull();
  });

  it("fails closed when route discovery is unavailable", async () => {
    mocks.fetchOptions.mockResolvedValue({ kind: "unavailable" });
    renderModal();

    expect(
      await screen.findByText(/couldn't check how this position can be withdrawn/i)
    ).toBeTruthy();
    expect(screen.queryByText("instant flow")).toBeNull();
    expect(screen.queryByText("async flow")).toBeNull();
  });

  it("retries through an abortable fetch so a superseded attempt cannot win", async () => {
    // The mock hands back a never-settling thenable per attempt so the test
    // delivers each response by hand — including one that arrives late, after
    // its attempt was already superseded by the retry.
    const deliveries: ((value: unknown) => void)[] = [];
    mocks.fetchOptions.mockImplementation(() => ({
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable — the test delivers each response by hand so a superseded answer can arrive late.
      then: (onFulfilled: (value: unknown) => void) => {
        deliveries.push(onFulfilled);
      },
    }));
    renderModal();

    expect(screen.getByRole("status")).toBeTruthy();

    act(() => deliveries[0]({ kind: "unavailable" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => expect(mocks.fetchOptions).toHaveBeenCalledTimes(2));
    const [firstSignal, secondSignal] = mocks.fetchOptions.mock.calls.map(
      (call) => call[1] as AbortSignal
    );
    // The retry's cleanup aborted the superseded first attempt...
    expect(firstSignal.aborted).toBe(true);
    // ...and the retry owns a live signal of its own.
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal.aborted).toBe(false);

    // The first attempt's late response loses to the pending retry: the abort
    // guard discards it instead of letting it overwrite the newer attempt.
    act(() =>
      deliveries[0]({
        kind: "ready",
        value: {
          positionId: position.id,
          instant: true,
          queued: false,
          withdrawAuthority: null,
          queueState: null,
          queueAsset: null,
        },
      })
    );
    expect(screen.queryByText("instant flow")).toBeNull();
    expect(screen.queryByText("async flow")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();

    // Only the retry's own response settles the chooser.
    act(() =>
      deliveries[1]({
        kind: "ready",
        value: {
          positionId: position.id,
          instant: false,
          queued: true,
          withdrawAuthority: "11111111111111111111111111111111",
          queueState: "queue",
          queueAsset: {
            assetMint: position.tokenMint,
            allowWithdrawals: true,
            secondsToMaturity: 60,
            minimumSecondsToDeadline: 120,
            minimumDiscountBps: 0,
            maximumDiscountBps: 100,
            minimumShares: "1",
            shareDecimals: 6,
          },
        },
      })
    );
    expect(await screen.findByText("async flow")).toBeTruthy();
    expect(screen.queryByText("instant flow")).toBeNull();
  });

  it("recovers into the route chooser after a successful retry", async () => {
    mocks.fetchOptions.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValue({
      kind: "ready",
      value: {
        positionId: position.id,
        instant: true,
        queued: false,
        withdrawAuthority: null,
        queueState: null,
        queueAsset: null,
      },
    });
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("instant flow")).toBeTruthy();
  });
});
