import type { PaymentRecurringPaymentStatus } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getRecurringPaymentDetailState } from "./recurring-payment-detail-state";

describe("getRecurringPaymentDetailState", () => {
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
        })
      ).toEqual({ sourceWalletUnresolved, isEditable, controlsDisabled });
    }
  );
});
