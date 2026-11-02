// @vitest-environment jsdom
import type { EarnVaultWithdrawal } from "@sdp/types/earn";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const order: EarnVaultWithdrawal = {
  movementId: "order",
  positionId: "position",
  provider: "plume",
  providerReference: "vault",
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
