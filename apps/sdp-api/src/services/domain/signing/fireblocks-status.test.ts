import {
  FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES,
  FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES,
  FIREBLOCKS_FAILED_TRANSACTION_STATUSES,
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
} from "@sdp/types/fireblocks";
import { describe, expect, it } from "vitest";

describe("Fireblocks cancellation states", () => {
  it.each(FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES)(
    "permits a best-effort cancellation request in %s",
    (status) => expect(isFireblocksTransactionCancellable(status)).toBe(true)
  );

  it.each(FIREBLOCKS_FAILED_TRANSACTION_STATUSES)("never cancels terminal %s again", (status) => {
    expect(isFireblocksTransactionCancellable(status)).toBe(false);
  });

  it.each(["BROADCASTING", "CONFIRMING", "COMPLETED", "CANCELLING", "UNKNOWN_STATE", ""])(
    "never infers cancellation safety from %s",
    (status) => expect(isFireblocksTransactionCancellable(status)).toBe(false)
  );
});

describe("Fireblocks cancellation verdicts", () => {
  it.each(FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES)("recognizes terminal %s", (status) => {
    expect(isFireblocksTransactionCancelled(status)).toBe(true);
  });

  it.each(["CANCELLING", "PENDING_SIGNATURE", "COMPLETED", "UNKNOWN_STATE"])(
    "does not mistake %s for a terminal cancellation",
    (status) => expect(isFireblocksTransactionCancelled(status)).toBe(false)
  );
});
