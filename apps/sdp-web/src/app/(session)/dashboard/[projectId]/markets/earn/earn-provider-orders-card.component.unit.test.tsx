// @vitest-environment jsdom
import type { EarnVaultWithdrawal } from "@sdp/types/earn";
import type { EarnProviderAction, EarnProviderActionStatus } from "@sdp/types/earn-provider-orders";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "@/app/(session)/dashboard/[projectId]/markets/test-i18n";
import { setWindowPathname } from "@/test/window-location";
import { EarnProviderOrdersCard } from "./earn-provider-orders-card";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  read: vi.fn(),
  rows: [] as EarnVaultWithdrawal[],
  canWrite: true,
}));
vi.mock("./earn-program-data", () => ({
  useEarnVaultWithdrawals: () => ({ withdrawals: mocks.rows, refresh: vi.fn() }),
}));
vi.mock("./earn-provider-actions", () => ({
  createEarnProviderAction: mocks.create,
  fetchEarnProviderAction: mocks.read,
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({ useCanWrite: () => mocks.canWrite }));
vi.mock("@/lib/use-dashboard-project", () => ({ useProjectId: () => "prj_test_sandbox" }));
const ownerAddress = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";
const order: EarnVaultWithdrawal = {
  movementId: "order",
  positionId: "position",
  provider: "plume",
  providerReference: "vault",
  ownerAddress,
  status: "confirmed",
  signature: "source",
  shares: "10",
  shareMint: "share",
  failureReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  confirmedAt: "2026-01-01T00:00:00.000Z",
  settledAt: null,
  redemptionMode: "standard",
};

const actionOf = (
  movementId: string,
  status: EarnProviderActionStatus,
  error: string | null = null
): EarnProviderAction => ({
  actionId: `action_${movementId}`,
  action: "cancellation",
  status,
  provider: "plume",
  providerReference: "vault",
  ownerAddress,
  feePayer: null,
  parentMovementId: movementId,
  signature: null,
  deliverySignature: null,
  lastValidBlockHeight: null,
  error,
  createdAt: "2026-01-01T00:00:00.000Z",
  transaction: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [order];
  mocks.canWrite = true;
  window.sessionStorage.clear();
  setWindowPathname("/dashboard/prj_test_sandbox/markets/treasury-solutions");
  mocks.create.mockResolvedValue({ actionId: "cancellation", status: "requested" });
});
afterEach(cleanup);
const renderCard = () =>
  render(
    <EnglishTestI18n>
      <EarnProviderOrdersCard />
    </EnglishTestI18n>
  );
describe("provider cancellation controls", () => {
  it("explains aggregate cancellation and submits only after confirmation", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Cancel pending redemption" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/all pending standard redemption shares/)).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        "cancellations",
        { movementId: "order" },
        expect.any(String)
      )
    );
  });
  it("identifies the wallet and vault before confirming", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Cancel pending redemption" }));
    // Equal-sized redemptions from different wallets render identical rows,
    // so the confirmation names exactly whose shares it would cancel.
    expect(screen.getByText("Wallet 7WLcnn…Aoxnpg · vault vault")).toBeTruthy();
  });
  it("identifies the vault before confirming when the owner is unknown", () => {
    mocks.rows = [{ ...order, ownerAddress: null }];
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Cancel pending redemption" }));
    // The movement's wallet is unresolvable, so the confirmation still names
    // the vault it would cancel against.
    expect(screen.getByText("Vault vault")).toBeTruthy();
  });
  it("keeps polling when every read fails identically", async () => {
    vi.useFakeTimers();
    try {
      mocks.read.mockRejectedValue(new Error("read failed"));
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Cancel pending redemption" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.create).toHaveBeenCalledWith(
        "cancellations",
        { movementId: "order" },
        expect.any(String)
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(mocks.read).toHaveBeenCalledTimes(1);
      // The second and third failures change no state and render nothing:
      // each next attempt is scheduled by the poll itself.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(mocks.read).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(mocks.read).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("applies the slower reply of one poll batch instead of dropping it", async () => {
    vi.useFakeTimers();
    try {
      const second = { ...order, movementId: "order-2" };
      mocks.rows = [order, second];
      mocks.create.mockImplementation(async (_kind: string, input: { movementId: string }) =>
        actionOf(input.movementId, "requested")
      );
      let releaseSecond: (action: unknown) => void = () => {};
      const secondReply = new Promise((resolve) => {
        releaseSecond = resolve;
      });
      mocks.read.mockImplementation(async (actionId: string) =>
        actionId === "action_order"
          ? actionOf("order", "confirmed")
          : await secondReply.then(() => actionOf("order-2", "failed", "boom"))
      );
      renderCard();
      // File both cancellations, so one poll batch reads two pending actions.
      fireEvent.click(screen.getAllByRole("button", { name: "Cancel pending redemption" })[0]);
      fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getAllByRole("button", { name: "Cancel pending redemption" })[1]);
      fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(mocks.read).toHaveBeenCalledTimes(2);
      // The first reply lands alone: it must not restart the poll in a way
      // that strands the slower second reply — its failed outcome surfaces
      // (and its retry key retires) as soon as the batch settles.
      releaseSecond(null);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("boom");
    } finally {
      vi.useRealTimers();
    }
  });
  it("hides cancellation from viewers", () => {
    mocks.canWrite = false;
    renderCard();
    expect(screen.queryByRole("button", { name: "Cancel pending redemption" })).toBeNull();
  });
  it("does not offer standard cancellation on instant redemptions", () => {
    mocks.rows = [{ ...order, redemptionMode: "instant" }];
    renderCard();
    expect(screen.queryByRole("button", { name: "Cancel pending redemption" })).toBeNull();
  });
});
