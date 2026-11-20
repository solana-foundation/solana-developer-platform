import {
  FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES,
  FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES,
  FIREBLOCKS_FAILED_TRANSACTION_STATUSES,
  isFireblocksProposalCancellable,
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
} from "@sdp/types/fireblocks";
import { describe, expect, it } from "vitest";

describe("Fireblocks cancellation states", () => {
  // Pinned by literal, not derived: the predicates are Sets built FROM these
  // constants, so positive cases derived from the constants prove only
  // `Set.has`. A gutted constant would run zero cases and silently stop
  // offering cancellation on every Fireblocks transfer; a wrong status added
  // to it (SIGNED already carries a signature) would be blessed. This pin is
  // the spec: the pre-broadcast provider states where a cancellation request
  // may still stop execution
  // (https://developers.fireblocks.com/reference/transaction-statuses).
  it("pins the pre-broadcast states a cancellation request may still stop", () => {
    expect([...FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES].sort()).toEqual([
      "PENDING_3RD_PARTY",
      "PENDING_3RD_PARTY_MANUAL_APPROVAL",
      "PENDING_AML_SCREENING",
      "PENDING_AUTHORIZATION",
      "PENDING_ENRICHMENT",
      "PENDING_SIGNATURE",
      "QUEUED",
      "SUBMITTED",
    ]);
  });

  it.each(FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES)(
    "permits a best-effort cancellation request in %s",
    (status) => {
      expect(isFireblocksTransactionCancellable(status)).toBe(true);
      expect(isFireblocksProposalCancellable(status)).toBe(true);
    }
  );

  it.each(FIREBLOCKS_FAILED_TRANSACTION_STATUSES)("never cancels terminal %s again", (status) => {
    expect(isFireblocksTransactionCancellable(status)).toBe(false);
    expect(isFireblocksProposalCancellable(status)).toBe(false);
  });

  it.each(["BROADCASTING", "CONFIRMING", "COMPLETED", "CANCELLING", "UNKNOWN_STATE", ""])(
    "never infers cancellation safety from %s",
    (status) => {
      expect(isFireblocksTransactionCancellable(status)).toBe(false);
      expect(isFireblocksProposalCancellable(status)).toBe(false);
    }
  );
});

describe("Fireblocks cancellation verdicts", () => {
  // Pinned by literal for the same reason the cancellable set is: the
  // predicate is a Set built from this constant, so a gutted constant would
  // run zero cases and read every real CANCELLED answer as "not proven",
  // re-arming a cancellation that already went through.
  it("pins the provider spellings that prove a terminal cancellation", () => {
    expect([...FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES].sort()).toEqual([
      "CANCELED",
      "CANCELLED",
    ]);
  });

  it.each(FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES)("recognizes terminal %s", (status) => {
    expect(isFireblocksTransactionCancelled(status)).toBe(true);
  });

  it.each(["CANCELLING", "PENDING_SIGNATURE", "COMPLETED", "UNKNOWN_STATE"])(
    "does not mistake %s for a terminal cancellation",
    (status) => expect(isFireblocksTransactionCancelled(status)).toBe(false)
  );
});
