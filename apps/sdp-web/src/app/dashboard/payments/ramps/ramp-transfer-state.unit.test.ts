import type { PaymentTransferStatus, PaymentTransferSummary } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CreateTransferOutcome } from "@/app/dashboard/payments/payments-workspace.data";
import { getRampTransferState, heldRampApprovalRequestId } from "./ramp-transfer-state";

describe("getRampTransferState", () => {
  it.each([
    ["pending", true, false],
    ["awaiting_payment", true, false],
    ["processing", false, false],
    ["confirmed", false, false],
    ["finalized", false, false],
    ["settling", false, false],
    ["completed", false, true],
    ["failed", false, true],
    ["canceled", false, true],
    ["expired", false, true],
  ] satisfies [PaymentTransferStatus, boolean, boolean][])(
    "%s maps to cancelable=%s and terminal=%s",
    (status, cancelable, terminal) => {
      const state = getRampTransferState(status);
      expect(state).toEqual({ cancelable, terminal });
      expect(state.cancelable && state.terminal).toBe(false);
    }
  );
});

describe("heldRampApprovalRequestId", () => {
  const held: CreateTransferOutcome = { kind: "approval_pending", approvalRequestId: "apr_ramp" };

  function rampTransfer(status: PaymentTransferStatus): PaymentTransferSummary {
    return {
      id: "xfr_ramp",
      custodyWalletId: "cwlt_ramp",
      providerWalletId: "wallet_ramp",
      status,
      signature: null,
      rampsMemo: {},
      type: "offramp",
    };
  }

  it("is null before any send and after a send that went out", () => {
    const submitted: CreateTransferOutcome = {
      kind: "submitted",
      transfer: rampTransfer("settling"),
    };
    expect(heldRampApprovalRequestId(null, rampTransfer("awaiting_payment"))).toBeNull();
    expect(heldRampApprovalRequestId(submitted, rampTransfer("awaiting_payment"))).toBeNull();
  });

  // The gate answers before the handler, so the row itself never says "held".
  it.each(["pending", "awaiting_payment"] satisfies PaymentTransferStatus[])(
    "holds while the row still reads %s",
    (status) => {
      expect(heldRampApprovalRequestId(held, rampTransfer(status))).toBe("apr_ramp");
    }
  );

  it("holds before the first poll arrives", () => {
    expect(heldRampApprovalRequestId(held, undefined)).toBe("apr_ramp");
  });

  it.each([
    "processing",
    "settling",
    "completed",
    "failed",
    "canceled",
    "expired",
  ] satisfies PaymentTransferStatus[])("lets the row win once it moves to %s", (status) => {
    expect(heldRampApprovalRequestId(held, rampTransfer(status))).toBeNull();
  });
});
