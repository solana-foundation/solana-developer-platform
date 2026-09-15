import type { PaymentRecurringPaymentStatus } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getRecurringPaymentDetailState } from "./recurring-payment-detail-state";

describe("getRecurringPaymentDetailState", () => {
  it("allows pending edits and cancellation while signing is unavailable", () => {
    expect(
      getRecurringPaymentDetailState({
        sourceCustodyWalletId: "cwlt_source",
        selectedCustodyWalletId: "cwlt_source",
        status: "pending_activation",
        hasPendingAction: false,
        savingPayment: false,
        sourceWallet: { isRuntimeExecutionAllowed: false },
        selectedWallet: { isRuntimeExecutionAllowed: false },
      })
    ).toMatchObject({
      isEditable: true,
      saveDisabled: false,
      signingActionsDisabled: true,
      signingDisabled: true,
      cancelDisabled: false,
    });
  });

  it("locks editing of an active payment while its wallet cannot sign", () => {
    expect(
      getRecurringPaymentDetailState({
        sourceCustodyWalletId: "cwlt_source",
        selectedCustodyWalletId: "cwlt_source",
        status: "active",
        hasPendingAction: false,
        savingPayment: false,
        sourceWallet: { isRuntimeExecutionAllowed: false },
        selectedWallet: { isRuntimeExecutionAllowed: false },
      })
    ).toMatchObject({ isEditable: false, signingActionsDisabled: true, cancelDisabled: true });
  });

  it("does not report a signing restriction for a wallet it cannot see", () => {
    expect(
      getRecurringPaymentDetailState({
        sourceCustodyWalletId: "cwlt_source",
        selectedCustodyWalletId: "cwlt_source",
        status: "active",
        hasPendingAction: false,
        savingPayment: false,
        sourceWallet: undefined,
        selectedWallet: undefined,
      })
    ).toMatchObject({ signingUnavailable: true, signingDisabled: false });
  });

  it.each([
    [null, "active", false, false, true, false, true],
    ["cwlt_exact", "active", false, false, false, true, false],
    ["cwlt_exact", "pending_activation", false, false, false, true, false],
    ["cwlt_exact", "paused", false, false, false, false, false],
    ["cwlt_exact", "active", true, false, false, true, true],
    ["cwlt_exact", "active", false, true, false, true, true],
  ] satisfies [
    string | null,
    PaymentRecurringPaymentStatus,
    boolean,
    boolean,
    boolean,
    boolean,
    boolean,
  ][])(
    "maps source=%s status=%s pending=%s saving=%s to unresolved=%s editable=%s disabled=%s",
    (sourceCustodyWalletId, status, hasPendingAction, savingPayment, sourceWalletUnresolved, isEditable, controlsDisabled) => {
      expect(
        getRecurringPaymentDetailState({
          sourceCustodyWalletId,
          status,
          hasPendingAction,
          savingPayment,
          sourceWallet: { isRuntimeExecutionAllowed: true },
          selectedWallet: { isRuntimeExecutionAllowed: true },
          selectedCustodyWalletId: sourceCustodyWalletId ?? "",
        })
      ).toMatchObject({ sourceWalletUnresolved, isEditable, controlsDisabled });
    }
  );
});
