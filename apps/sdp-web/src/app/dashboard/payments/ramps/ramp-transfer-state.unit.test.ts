import type { PaymentTransferStatus } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getRampTransferState } from "./ramp-transfer-state";

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

  it("defaults a missing status to non-cancelable and non-terminal", () => {
    expect(getRampTransferState(undefined)).toEqual({ cancelable: false, terminal: false });
  });
});
