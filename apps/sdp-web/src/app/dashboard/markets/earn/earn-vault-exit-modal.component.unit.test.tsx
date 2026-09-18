// @vitest-environment jsdom

import type { EarnVaultPosition } from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const mocks = vi.hoisted(() => ({
  fetchOptions: vi.fn(),
  asyncModal: undefined as
    | {
        onSettled?: (event: { kind: "queue"; request: { withdrawalRequestId: string } }) => void;
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

    expect(await screen.findByRole("button", { name: /Instant withdrawal/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Asynchronous withdrawal/ })).toBeTruthy();
    expect(screen.getByText(/approximately 60 seconds/)).toBeTruthy();
    expect(screen.queryByText(/approximately 0 seconds/)).toBeNull();
    expect(screen.queryByText("instant flow")).toBeNull();
    expect(screen.queryByText("async flow")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Asynchronous withdrawal/ }));
    expect(await screen.findByText("async flow")).toBeTruthy();
  });

  it("forwards asynchronous settlement so Treasury can refresh custody balances", async () => {
    const onAsyncRequestSettled = vi.fn();
    mocks.fetchOptions.mockResolvedValue({
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

  it("fails closed when route discovery is unavailable", async () => {
    mocks.fetchOptions.mockResolvedValue({ kind: "unavailable" });
    renderModal();

    expect(await screen.findByText(/No route was selected/)).toBeTruthy();
    expect(screen.queryByText("instant flow")).toBeNull();
    expect(screen.queryByText("async flow")).toBeNull();
  });
});
