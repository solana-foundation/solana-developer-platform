import { describe, expect, it } from "vitest";
import { earnVaultDepositUiState, earnVaultWithdrawalUiState } from "./earn-vault-ui-state";

describe("earn vault UI state", () => {
  it("keeps deposit progress and the position badge on one mapping", () => {
    expect(earnVaultDepositUiState("pending")).toEqual({
      positionStatus: "pending",
      progressStep: 2,
    });
    expect(earnVaultDepositUiState("submitted")).toEqual({
      positionStatus: "pending",
      progressStep: 2,
    });
    expect(earnVaultDepositUiState("confirmed")).toEqual({
      positionStatus: "active",
      progressStep: 3,
    });
  });

  it("keeps withdrawal progress and the position badge on one mapping", () => {
    expect(earnVaultWithdrawalUiState("requested")).toEqual({
      positionStatus: "pending",
      progressStep: 2,
    });
    expect(earnVaultWithdrawalUiState("submitted")).toEqual({
      positionStatus: "pending",
      progressStep: 2,
    });
    expect(earnVaultWithdrawalUiState("confirmed")).toEqual({
      positionStatus: "pending",
      progressStep: 2,
    });
    expect(earnVaultWithdrawalUiState("finalized")).toEqual({
      positionStatus: "active",
      progressStep: 3,
    });
  });
});
