import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey } from "@/i18n/messages";
import { type TranslationValues, translate } from "@/i18n/translate";
import {
  earnVaultDepositUiState,
  earnVaultWithdrawalPositionStatusLabels,
  earnVaultWithdrawalUiState,
} from "./earn-vault-ui-state";

const t = (key: MessageKey, values?: TranslationValues) =>
  translate(getMessages("en"), key, values);

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
      positionStatus: "active",
      progressStep: 3,
    });
    expect(earnVaultWithdrawalUiState("finalized")).toEqual({
      positionStatus: "active",
      progressStep: 3,
    });
  });
});

describe("earnVaultWithdrawalPositionStatusLabels", () => {
  it("closes the position when a settled exit redeemed every share it held", () => {
    for (const status of ["confirmed", "finalized"] as const) {
      expect(earnVaultWithdrawalPositionStatusLabels({ shares: "10", status }, "10", t)).toEqual({
        label: "Closed",
        variant: "success",
      });
    }
    expect(
      earnVaultWithdrawalPositionStatusLabels({ shares: "10.0", status: "finalized" }, "9.5", t)
    ).toEqual({ label: "Closed", variant: "success" });
  });

  it("keeps the position Active after a partial exit", () => {
    expect(
      earnVaultWithdrawalPositionStatusLabels({ shares: "4", status: "finalized" }, "10", t)
    ).toEqual({ label: "Active", variant: "success" });
  });

  it("never closes on an exit that has not settled", () => {
    expect(
      earnVaultWithdrawalPositionStatusLabels({ shares: "10", status: "submitted" }, "10", t)
    ).toEqual({ label: "Pending", variant: "warning" });
    expect(
      earnVaultWithdrawalPositionStatusLabels({ shares: "10", status: "failed" }, "10", t)
    ).toEqual({ label: "Active", variant: "success" });
  });

  it("defers to the withdrawal's own status when the holding cannot be counted", () => {
    expect(
      earnVaultWithdrawalPositionStatusLabels({ shares: "10", status: "finalized" }, undefined, t)
    ).toBeUndefined();
    expect(
      earnVaultWithdrawalPositionStatusLabels({ shares: "10", status: "finalized" }, "n/a", t)
    ).toBeUndefined();
  });
});
