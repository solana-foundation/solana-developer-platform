import { describe, expect, it } from "vitest";
import { shouldOpenPendingFundManagementModal } from "./asset-management-workspace";

describe("shouldOpenPendingFundManagementModal", () => {
  it("keeps the pending deploy modal action queued until the operations tab is active", () => {
    expect(
      shouldOpenPendingFundManagementModal({
        activeTab: "overview",
        pendingFundManagementModalAction: "deploy",
      })
    ).toBe(false);

    expect(
      shouldOpenPendingFundManagementModal({
        activeTab: "operations",
        pendingFundManagementModalAction: "deploy",
      })
    ).toBe(true);
  });
});
