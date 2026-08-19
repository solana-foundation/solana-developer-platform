import { FeePaymentError } from "@sdp/payments/fee-payment";
import { describe, expect, it, vi } from "vitest";
import {
  isPreBroadcastRejection,
  persistOutcomeUnknownMarker,
  SUBMISSION_OUTCOME_UNKNOWN_MARKER,
} from "./submission-outcome";

describe("isPreBroadcastRejection", () => {
  it.each([
    "SIGNING_FAILED",
    "TRANSACTION_TOO_LARGE",
    "INSUFFICIENT_BALANCE",
    "RATE_LIMITED",
  ] as const)("treats a deterministic %s rejection as pre-broadcast", (code) => {
    expect(isPreBroadcastRejection(new FeePaymentError("rejected", code))).toBe(true);
  });

  it("treats an in-band simulation error as pre-broadcast whatever the code", () => {
    // Kora surfaces simulation rejections as RPC -32000, which maps to
    // NETWORK_ERROR — the message text is the only in-band evidence.
    const error = new FeePaymentError(
      "Failed to sign and send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
      "NETWORK_ERROR"
    );
    expect(isPreBroadcastRejection(error)).toBe(true);
  });

  it("treats a plain simulation error object as pre-broadcast", () => {
    expect(
      isPreBroadcastRejection(new Error("Transaction simulation failed: custom program error: 0x1"))
    ).toBe(true);
  });

  it.each(["SUBMISSION_FAILED", "NETWORK_ERROR", "PROVIDER_NOT_AVAILABLE"] as const)(
    "refuses to certify a plain %s as pre-broadcast",
    (code) => {
      expect(isPreBroadcastRejection(new FeePaymentError("boom", code))).toBe(false);
    }
  );

  it("never certifies pre-broadcast once an earlier attempt may have broadcast", () => {
    // The verdict travels as data: a deterministic-looking code after a lost
    // response can be CAUSED by the hidden broadcast (spent funds ->
    // INSUFFICIENT_BALANCE), so the flag beats the code.
    const flagged = new FeePaymentError("insufficient balance", "INSUFFICIENT_BALANCE", undefined, {
      maybeBroadcast: true,
    });
    expect(isPreBroadcastRejection(flagged)).toBe(false);
  });

  it("the flag also beats the simulation-text heuristic", () => {
    const flagged = new FeePaymentError(
      "RPC Error -32000: Transaction simulation failed: custom program error: 0x1",
      "NETWORK_ERROR",
      undefined,
      { maybeBroadcast: true }
    );
    expect(isPreBroadcastRejection(flagged)).toBe(false);
  });

  it("does not certify non-errors", () => {
    expect(isPreBroadcastRejection("custom program error: 0x1")).toBe(false);
    expect(isPreBroadcastRejection(null)).toBe(false);
  });
});

describe("SUBMISSION_OUTCOME_UNKNOWN_MARKER", () => {
  it("is the literal durable contract jobs match in SQL", () => {
    // Rows already written in production must keep matching even if the
    // constant is ever renamed — pin the exact shape.
    expect(SUBMISSION_OUTCOME_UNKNOWN_MARKER).toEqual({ submission_outcome: "unknown" });
  });
});

describe("persistOutcomeUnknownMarker", () => {
  it("persists on the first attempt", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    await persistOutcomeUnknownMarker(persist, "tr_1");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("retries once after a failed write", async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(undefined);
    await persistOutcomeUnknownMarker(persist, "tr_1");
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("never throws even when both writes fail", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(persistOutcomeUnknownMarker(persist, "tr_1")).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
